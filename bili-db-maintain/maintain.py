#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bili index.db 维护器 —— 达到阈值才压缩（默认 1 GiB）

用法:
  python maintain.py check                 # 只报告，不动数据（退出码 10 = 已超阈值）
  python maintain.py vacuum                # 超阈值才执行
  python maintain.py vacuum --force        # 不管阈值，强制执行
  python maintain.py vacuum --threshold-mb 1024

机制:
  库已切到 PRAGMA auto_vacuum=INCREMENTAL（auto_vacuum=2）。
  孤儿 blob 删掉后，用 incremental_vacuum 分批把空洞还给文件系统，
  每批只锁几十~两百毫秒，bili 的 busy_timeout=5000 ms 完全吃得下。
  若某天库被外部工具重建成 auto_vacuum=0，脚本自动回退到整库 VACUUM。
"""
import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime

BASE = r"D:\DSH\.dsh\cache\bili-db-maintain"
# 真库路径；可用环境变量 BILI_DB 覆盖（在副本上验证时用）
DB = os.environ.get("BILI_DB") or os.path.expanduser(
    r"~\.local\share\billion-context\sessions\index.db"
)
# 备份目录跟着被测库走：真库用 BASE\backups；BILI_DB 指向副本时落到副本旁边的 _backups，
# 免得拿测试库把真备份挤掉（KEEP_BACKUPS 只留 2 份）。
BACKUP_DIR = (
    os.path.join(BASE, "backups")
    if os.environ.get("BILI_DB") is None
    else os.path.join(os.path.dirname(DB), "_backups")
)
LOG = os.path.join(BASE, "maintain.log")
DEFAULT_THRESHOLD_MB = 1024
KEEP_BACKUPS = 2
BUSY_TIMEOUT_MS = 30000
INCR_BATCH_PAGES = 256          # 每批回收的页数；256 x 4 KB = 1 MB
MIN_RECLAIM_BYTES = 8 * 1048576  # 可回收不足 8 MB 就不动（清理本身没收益）

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def log(msg):
    line = f"{datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line, flush=True)
    try:
        os.makedirs(BASE, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def mb(n):
    return n / 1048576.0


def connect(readonly=True):
    if readonly:
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=BUSY_TIMEOUT_MS / 1000)
    c = sqlite3.connect(DB, timeout=BUSY_TIMEOUT_MS / 1000)
    c.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    return c


def snapshot_stats(cur):
    page_size = cur.execute("PRAGMA page_size").fetchone()[0]
    page_count = cur.execute("PRAGMA page_count").fetchone()[0]
    freelist = cur.execute("PRAGMA freelist_count").fetchone()[0]
    auto_vac = cur.execute("PRAGMA auto_vacuum").fetchone()[0]
    orphans, orphan_bytes = cur.execute(
        "SELECT count(*), coalesce(sum(byte_len),0) FROM content WHERE refcount <= 0"
    ).fetchone()
    total_rows, total_bytes = cur.execute(
        "SELECT count(*), coalesce(sum(byte_len),0) FROM content"
    ).fetchone()
    return {
        "page_size": page_size,
        "page_count": page_count,
        "freelist": freelist,
        "auto_vacuum": auto_vac,
        "db_bytes": os.path.getsize(DB),
        "wal_bytes": os.path.getsize(DB + "-wal") if os.path.exists(DB + "-wal") else 0,
        "orphans": orphans,
        "orphan_bytes": orphan_bytes,
        "content_rows": total_rows,
        "content_bytes": total_bytes,
        "reclaimable": freelist * page_size + orphan_bytes,
    }


def cmd_check(args):
    c = connect()
    cur = c.cursor()
    s = snapshot_stats(cur)
    c.close()
    thr = args.threshold_mb * 1048576
    mode = {0: "NONE（整库 VACUUM）", 1: "FULL", 2: "INCREMENTAL（分批回收）"}.get(s["auto_vacuum"], s["auto_vacuum"])
    print("=== bili index.db 体检 ===")
    print(f"  主文件       {mb(s['db_bytes']):9.1f} MB   ({s['db_bytes']/thr*100:5.1f}% of {args.threshold_mb} MB 阈值)")
    print(f"  WAL          {mb(s['wal_bytes']):9.1f} MB")
    print(f"  回收模式     auto_vacuum={s['auto_vacuum']}  {mode}")
    print(f"  页 {s['page_count']} x {s['page_size']} B，空闲页 {s['freelist']}")
    print(f"  content 行   {s['content_rows']} 行 / {mb(s['content_bytes']):.1f} MB 实际字节")
    print(f"  孤儿 content {s['orphans']} 行 / {mb(s['orphan_bytes']):.1f} MB  (refcount<=0)")
    print(f"  可回收       {mb(s['reclaimable']):.1f} MB")
    need = s["db_bytes"] >= thr
    print()
    print(f"  结论: {'⚠ 已达阈值，建议 vacuum' if need else '✓ 未达阈值，不动'}")
    return 10 if need else 0


def make_backup():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = os.path.join(BACKUP_DIR, f"index-{stamp}.db")
    t = time.perf_counter()
    src = connect(readonly=True)
    out = sqlite3.connect(dst)
    src.backup(out)
    out.close()
    src.close()
    log(f"[backup] {os.path.basename(dst)}  {mb(os.path.getsize(dst)):.1f} MB  ({time.perf_counter()-t:.2f}s)")
    return dst


def prune_backups():
    try:
        files = sorted(
            (f for f in os.listdir(BACKUP_DIR) if f.startswith("index-") and f.endswith(".db")),
            reverse=True,
        )
        for f in files[KEEP_BACKUPS:]:
            os.remove(os.path.join(BACKUP_DIR, f))
            log(f"[prune] 删除旧备份 {f}")
    except FileNotFoundError:
        pass


def reclaim_incremental(cur):
    """分批增量回收，每批只短暂持锁。返回（批数, 总耗时, 单批最长）。"""
    t0 = time.perf_counter()
    batches = 0
    worst = 0.0
    while True:
        t = time.perf_counter()
        cur.execute(f"PRAGMA incremental_vacuum({INCR_BATCH_PAGES})").fetchall()
        dt = time.perf_counter() - t
        worst = max(worst, dt)
        batches += 1
        if cur.execute("PRAGMA freelist_count").fetchone()[0] == 0:
            break
        if batches > 20000:
            log("[warn] 增量回收超过 20000 批，停止")
            break
    return batches, time.perf_counter() - t0, worst


def cmd_vacuum(args):
    thr = args.threshold_mb * 1048576
    size0 = os.path.getsize(DB)

    c = connect(readonly=True)
    s = snapshot_stats(c.cursor())
    c.close()

    if size0 < thr and not args.force:
        log(f"[skip] {mb(size0):.1f} MB < 阈值 {args.threshold_mb} MB，不压缩")
        return 0

    log(f"[start] {mb(size0):.1f} MB | 孤儿 {s['orphans']} 行 / {mb(s['orphan_bytes']):.1f} MB | 空闲页 {s['freelist']} | auto_vacuum={s['auto_vacuum']}")

    if s["reclaimable"] < args.min_reclaim_mb * 1048576:
        log(f"[skip] 可回收空间 < {args.min_reclaim_mb} MB，不值得动")
        return 0

    make_backup()

    t_total = time.perf_counter()
    try:
        c = connect(readonly=False)
        cur = c.cursor()

        t = time.perf_counter()
        n = cur.execute("SELECT count(*) FROM content WHERE refcount <= 0").fetchone()[0]
        cur.execute("DELETE FROM content WHERE refcount <= 0")
        c.commit()
        log(f"[orphans] 删除 {n} 条，{(time.perf_counter()-t)*1000:.0f} ms")

        if s["auto_vacuum"] == 2:
            batches, elapsed, worst = reclaim_incremental(cur)
            c.commit()
            log(f"[incr-vacuum] {batches} 批 x {INCR_BATCH_PAGES} 页，总 {elapsed:.2f}s，单批最长 {worst*1000:.0f} ms")
        else:
            t = time.perf_counter()
            cur.execute("VACUUM")
            log(f"[vacuum] 整库重写 {time.perf_counter()-t:.2f}s（auto_vacuum=0 回退路径）")

        t = time.perf_counter()
        check = cur.execute("PRAGMA integrity_check").fetchone()[0]
        log(f"[verify] integrity_check = {check}  ({(time.perf_counter()-t):.2f}s)")
        cur.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        c.close()

        if check != "ok":
            log(f"[FAIL] integrity_check 不是 ok: {check}；备份在 {BACKUP_DIR}")
            return 1
    except Exception as e:
        log(f"[FAIL] {type(e).__name__}: {e}；备份在 {BACKUP_DIR}")
        return 1

    size1 = os.path.getsize(DB)
    log(f"[done] {mb(size0):.1f} MB -> {mb(size1):.1f} MB  (释放 {mb(size0-size1):.1f} MB，总计 {time.perf_counter()-t_total:.1f}s)")
    prune_backups()
    return 0


def main():
    ap = argparse.ArgumentParser(description="bili index.db 维护器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("check", help="只报告")
    a.add_argument("--threshold-mb", type=int, default=DEFAULT_THRESHOLD_MB)

    b = sub.add_parser("vacuum", help="超阈值才压缩")
    b.add_argument("--threshold-mb", type=int, default=DEFAULT_THRESHOLD_MB)
    b.add_argument("--min-reclaim-mb", type=int, default=8, help="可回收不足此值就跳过（默认 8 MB）")
    b.add_argument("--force", action="store_true", help="忽略阈值")

    args = ap.parse_args()
    if args.cmd == "check":
        return cmd_check(args)
    return cmd_vacuum(args)


if __name__ == "__main__":
    sys.exit(main())
