#!/usr/bin/env python3
r"""dsh-auth-cookie-doctor —— 诊断/清理 DSH Desktop 累积的 dsh-auth-* cookie。

为什么需要它：
  DSH Desktop 每个启动周期由 host 签发**一个新名字**的 cookie
  （`dsh-auth-<32位随机>`，30 天过期，旧的不撤销），而
  D:\DSH\resources\app\lib\main.js:12244 把 `session.defaultSession.cookies.get({url})`
  返回的**全部** cookie 拼成一个 Cookie 头：

      async () => (await session.defaultSession.cookies.get({ url: ready.url }))
          .map((c) => `${c.name}=${c.value}`).join("; ")

  每个 cookie 约 223 字节（name 48 + value 173 + "=; "），累积到 71 个 = 16186 字节，
  再加 Host/User-Agent 等就顶穿 Node 默认 maxHeaderSize=16384 →
  host 侧拒绝 → `net.fetch(ready.url,{credentials:'include'})` 返回非 2xx →
  启动抛 `desktop welcome: Web authentication failed`
  （2026-10-22 01:32~01:37 实测崩了 10 次，换空 userData 目录即恢复）。

用法：
  python dsh-auth-cookie-doctor.py            # 只报告
  python dsh-auth-cookie-doctor.py --clean    # 删掉多余的 dsh-auth-*（先备份库文件）
  python dsh-auth-cookie-doctor.py --keep 1 --clean   # 只留最近访问的 1 个
"""

import os
import shutil
import sqlite3
import sys
import time

try:  # Windows 控制台默认 GBK，中文 + 符号会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

NODE_MAX_HEADER = 16384
COOKIE_BUDGET = 12000  # 留足别的请求头余量，超过就建议清理


def candidates():
    roaming = os.environ.get("APPDATA") or os.path.expanduser(r"~\AppData\Roaming")
    base = os.path.join(roaming, "@deepseek-ai", "dsh-desktop")
    return [os.path.join(base, "Network", "Cookies")]


def load(path):
    con = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    rows = con.execute(
        "select host_key, name, value, length(encrypted_value), "
        "datetime(expires_utc/1000000-11644473600,'unixepoch'), "
        "datetime(last_access_utc/1000000-11644473600,'unixepoch') "
        "from cookies order by last_access_utc desc"
    ).fetchall()
    con.close()
    return rows


def report(path, rows):
    auth = [r for r in rows if r[1].startswith("dsh-auth-")]
    header = "; ".join(f"{r[1]}={r[2]}" for r in rows if r[3] == 0)
    size = len(header.encode())
    print(f"库文件: {path}")
    print(f"  总 cookie 数 : {len(rows)}")
    print(f"  dsh-auth-*   : {len(auth)}")
    if auth:
        print(f"  最近签发     : {auth[0][1][:36]}  last_access {auth[0][5]}")
        if len(auth) > 1:
            print(f"  最老签发     : {auth[-1][1][:36]}  last_access {auth[-1][5]}")
    print(f"  Cookie 头估算 : {size} 字节（不含 Host/UA 等其余头）")
    print(f"  Node 上限     : {NODE_MAX_HEADER} 字节")
    if size >= COOKIE_BUDGET:
        print(f"  [!] 已超安全线 {COOKIE_BUDGET}：启动会抛 desktop welcome: Web authentication failed")
    elif size + 600 >= NODE_MAX_HEADER:
        print("  [!] 距上限不足 600 字节：下一次启动很可能崩")
    else:
        print("  [ok] 安全")
    return size


def clean(path, keep, min_n=0):
    rows = load(path)
    auth = [r for r in rows if r[1].startswith("dsh-auth-")]
    floor = max(keep, min_n)
    if len(auth) <= floor:
        print(f"dsh-auth-* 只有 {len(auth)} 个（水位 {floor}），无需清理")
        return 0
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{path}.bak-{stamp}"
    shutil.copy2(path, backup)
    print(f"已备份: {backup}")
    victims = [r[1] for r in auth[keep:]]
    con = sqlite3.connect(path)
    con.executemany("delete from cookies where host_key='127.0.0.1' and name=?", [(n,) for n in victims])
    con.commit()
    con.close()
    print(f"已删除 {len(victims)} 个 dsh-auth-*，保留 {keep} 个")
    return len(victims)


def main(argv):
    keep = 1
    min_n = 0
    if "--min" in argv:
        try:
            min_n = int(argv[argv.index("--min") + 1])
        except (IndexError, ValueError):
            print("--min 需要一个数字（cookie 数不超过它就不清）")
            return 2
    paths = None
    if "--path" in argv:
        try:
            paths = [argv[argv.index("--path") + 1]]
        except IndexError:
            print("--path 需要一个 Cookies 库文件路径")
            return 2
    if "--keep" in argv:
        try:
            keep = int(argv[argv.index("--keep") + 1])
        except (IndexError, ValueError):
            print("--keep 需要一个数字")
            return 2
    do_clean = "--clean" in argv
    found = False
    for path in (paths or candidates()):
        if not os.path.exists(path):
            continue
        found = True
        try:
            rows = load(path)
        except Exception as exc:  # 库被 DSH 独占
            print(f"{path}")
            print(f"  [X] 读不到（{exc}）")
            print("      DSH 正在运行时会独占这个库 —— 完全退出 DSH 后再跑本工具")
            print()
            continue
        report(path, rows)
        if do_clean:
            print()
            n = clean(path, keep, min_n)
            if n:
                print("清理后：")
                report(path, load(path))
        print()
    if not found:
        print(r"没找到 DSH Desktop 的 Cookies 库（%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
