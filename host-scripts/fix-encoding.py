# -*- coding: utf-8 -*-
r"""
fix-encoding.py —— 把非 UTF-8 文本文件转成 UTF-8-BOM
（Windows 记事本 / Notepad++ / VS Code / 浏览器 都能直接正常显示，不再乱码）

用法：
  python fix-encoding.py "D:/某个目录"                        只扫描出报告，不动文件
  python fix-encoding.py "D:/某个目录" --go                   原地转换（自动全量备份原文件）
  python fix-encoding.py "D:/某个目录" --go --mirror "D:/out"  结果写到别处，原目录一个字不改
  python fix-encoding.py "D:/某个目录" --ext txt,srt,md       只处理这些扩展名

判编码的顺序（关键）：
  1. 有 BOM 直接认（UTF-8-BOM / UTF-16LE / UTF-16BE）
  2. 大量 0x00 间隔 -> 无 BOM 的 UTF-16
  3. 能按 UTF-8 解 -> UTF-8
  4. 按 cp932(Shift-JIS) 解，假名比例 >= 2% -> 日文
     这一步必须在 GBK 之前！Shift-JIS 的字节流用 GBK 也能解，
     会得出「偙偺搙偼」这种看着像中文的乱码，只试 GBK 必判错。
  5. 按 GBK 解 -> 中文
  6. cp932 / euc_kr / cp1251 / cp1252 兜底（俄文、法文说明）
  7. 都不行 -> 跳过并报告

安全护栏：
  * 按扩展名硬排除二进制（docx/pdf/jpg/png/vmd/pmx/zip/mp4...），文件名带 readme 也不碰
  * .fx 着色器默认不转（MME 按系统代码页读，改成 UTF-8-BOM 会加载失败）
  * --go 先整份 copy 到备份目录再写，出错可整目录还原
  * 只处理 8 MB 以下的文件
"""
import os
import sys
import shutil
import datetime

DEFAULT_EXT = {'.txt', '.md', '.srt', '.nfo', '.ini', '.cfg', '.conf', '.log',
               '.csv', '.json', '.xml', '.html', '.htm', '.mme', '.py', '.js', '.bat'}

# 二进制扩展名：硬排除，哪怕文件名里带 readme
BINARY_EXT = {'.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf',
              '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico', '.tga', '.dds',
              '.vmd', '.vpd', '.pmx', '.pmd', '.x', '.vac', '.fx',
              '.zip', '.rar', '.7z', '.gz', '.tar', '.lzh', '.bz2',
              '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.avi', '.mkv', '.webm',
              '.exe', '.dll', '.so', '.bin', '.dat', '.db', '.ttf', '.otf', '.ttc'}

NAME_HINTS = ('readme', 'read me', 'read-me', '说明', '规约', '利用規約',
              'license', '注意', '必読', '読んで', '读我')

SKIP_ENC = {'UTF-8', 'UTF-8-BOM'}

CODEC = {'GBK': 'gbk', 'SHIFT_JIS': 'cp932', 'UTF-16LE': 'utf-16-le',
         'UTF-16BE': 'utf-16-be', 'EUC-KR': 'euc_kr', 'CP1251': 'cp1251', 'CP1252': 'cp1252'}

KANA_LO = 0x3040
KANA_HI = 0x30ff


def kana_ratio(t):
    if not t:
        return 0.0
    kana = 0
    for c in t:
        o = ord(c)
        if KANA_LO <= o <= KANA_HI:
            kana += 1
    return kana / len(t)


def latin_ratio(t):
    if not t:
        return 0.0
    n = 0
    for c in t:
        if ('a' <= c <= 'z') or ('A' <= c <= 'Z') or c == ' ':
            n += 1
    return n / len(t)


def decode_any(b):
    """返回 (编码名, 文本)。判不出返回 ('UNKNOWN','')，二进制返回 ('BINARY','')。"""
    if b.startswith(b'\xef\xbb\xbf'):
        try:
            return 'UTF-8-BOM', b[3:].decode('utf-8')
        except UnicodeDecodeError:
            return 'UNKNOWN', ''
    if b.startswith(b'\xff\xfe'):
        return 'UTF-16LE', b[2:].decode('utf-16-le', 'replace')
    if b.startswith(b'\xfe\xff'):
        return 'UTF-16BE', b[2:].decode('utf-16-be', 'replace')

    if b.count(b'\x00') > len(b) * 0.25:
        even0 = b[0::2].count(0)
        odd0 = b[1::2].count(0)
        if odd0 > even0 * 3:
            return 'UTF-16LE', b.decode('utf-16-le', 'replace')
        if even0 > odd0 * 3:
            return 'UTF-16BE', b.decode('utf-16-be', 'replace')

    if b.count(b'\x00') > len(b) * 0.05:
        return 'BINARY', ''

    try:
        return 'UTF-8', b.decode('utf-8')
    except UnicodeDecodeError:
        pass

    try:
        t = b.decode('cp932')
        if kana_ratio(t) >= 0.02:
            return 'SHIFT_JIS', t
    except UnicodeDecodeError:
        pass

    try:
        return 'GBK', b.decode('gbk')
    except UnicodeDecodeError:
        pass

    for enc, label in (('cp932', 'SHIFT_JIS'), ('euc_kr', 'EUC-KR')):
        try:
            return label, b.decode(enc)
        except UnicodeDecodeError:
            continue

    for enc in ('cp1251', 'cp1252'):
        try:
            t = b.decode(enc)
            if latin_ratio(t) >= 0.5:
                return enc.upper(), t
        except UnicodeDecodeError:
            continue

    return 'UNKNOWN', ''


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        return 0

    root = args[0]
    if not os.path.isdir(root):
        print('目录不存在:', root)
        return 1

    go = '--go' in args
    mirror = args[args.index('--mirror') + 1] if '--mirror' in args else None
    backup = args[args.index('--backup') + 1] if '--backup' in args else None

    exts = set(DEFAULT_EXT)
    if '--ext' in args:
        exts = {'.' + e.strip().lstrip('.').lower() for e in args[args.index('--ext') + 1].split(',')}

    if go and not mirror and not backup:
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = os.path.abspath(os.path.join(root, '..', 'encoding-backup-' + stamp))

    todo = []
    stats = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            ext = os.path.splitext(fn)[1].lower()
            if ext in BINARY_EXT:
                stats['(二进制跳过)'] = stats.get('(二进制跳过)', 0) + 1
                continue
            low = fn.lower()
            if ext not in exts and not any(h in low for h in NAME_HINTS):
                continue
            try:
                sz = os.path.getsize(p)
                if sz == 0 or sz > 8 * 1024 * 1024:
                    continue
                b = open(p, 'rb').read()
            except OSError:
                continue
            enc, text = decode_any(b)
            stats[enc] = stats.get(enc, 0) + 1
            if enc in SKIP_ENC or enc in ('BINARY', 'UNKNOWN'):
                continue
            todo.append((p, enc, sz))

    print('扫描根目录:', root)
    print('编码分布:')
    for k in sorted(stats, key=lambda x: -stats[x]):
        print('   %-14s %d' % (k, stats[k]))
    print()
    print('需转换: %d 个，合计 %.2f MB' % (len(todo), sum(t[2] for t in todo) / 1048576))

    if not todo:
        return 0

    if not go:
        print()
        print('[预览模式] 前 20 条:')
        for p, enc, sz in todo[:20]:
            print('   [%-10s] %8d  %s' % (enc, sz, p))
        print()
        print('确认无误后加 --go 真正执行。原文件会先备份。')
        return 0

    ok = 0
    fail = 0
    failures = []
    for p, enc, sz in todo:
        try:
            raw = open(p, 'rb').read()
            if raw.startswith(b'\xef\xbb\xbf'):
                raw = raw[3:]
            elif raw.startswith(b'\xff\xfe') or raw.startswith(b'\xfe\xff'):
                raw = raw[2:]
            text = raw.decode(CODEC[enc])
            text = text.replace('\r\n', '\n').replace('\r', '\n')
            data = b'\xef\xbb\xbf' + text.encode('utf-8')

            dst = p
            if mirror:
                dst = os.path.join(mirror, os.path.relpath(p, root))
            parent = os.path.dirname(dst)
            if parent:
                os.makedirs(parent, exist_ok=True)

            if backup and not mirror:
                bp = os.path.join(backup, os.path.relpath(p, root))
                bparent = os.path.dirname(bp)
                if bparent:
                    os.makedirs(bparent, exist_ok=True)
                if not os.path.exists(bp):
                    shutil.copy2(p, bp)

            with open(dst, 'wb') as f:
                f.write(data)
            ok += 1
        except Exception as e:
            fail += 1
            failures.append((p, str(e)))

    print()
    print('[已执行] 成功 %d / 失败 %d' % (ok, fail))
    if failures:
        print('失败明细（前 10）:')
        for p, e in failures[:10]:
            print('   ', p, '::', e)
    if backup and not mirror:
        print('原文件备份:', backup)
    return 0 if fail == 0 else 2


if __name__ == '__main__':
    sys.exit(main())
