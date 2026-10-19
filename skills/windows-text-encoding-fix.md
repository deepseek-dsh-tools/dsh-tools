---
name: "windows-text-encoding-fix"
description: "Windows 上文件打开是乱码时怎么办：判编码的正确顺序（cp932 必须早于 gbk）、转成 UTF-8-BOM、以及哪些二进制/fx 文件绝不能碰。"
whenToUse: "用户说文件乱码、文本打开是方块/问号、要批量转编码、或者要判断一批文件是不是 GBK/日文/UTF-16 时。"
metadata:
  managed: true
  source: "model"
---

## 一句话

Windows 上「文件打开是乱码」= 编码问题，不是字体问题。装字体只解决缺字形显示成方块；改了编码才能读懂内容。

## 诊断：怎么判一份文件是什么编码

顺序很重要，**cp932 必须在 gbk 之前**：

1. **BOM**：`\xEF\xBB\xBF` = UTF-8-BOM；`\xFF\xFE` = UTF-16LE；`\xFE\xFF` = UTF-16BE
2. **无 BOM 的 UTF-16**：字节大量 0x00，且奇偶位分布不均（`b[1::2].count(0) > b[0::2].count(0)*3` → LE）
3. **UTF-8**：`b.decode('utf-8')` 成功就是（无 BOM 也常见）
4. **Shift-JIS**：`b.decode('cp932')` 成功 **且假名占比 ≥ 2%**（`'\u3040' <= c <= '\u30ff'`）
5. **GBK**：`b.decode('gbk')` 成功
6. 兜底：cp932 / euc_kr / cp1251（俄文）/ cp1252（法文）
7. 全失败 → 报 UNKNOWN 跳过，别瞎猜

**核心坑**：Shift-JIS 的字节流用 GBK 也能解开，会得出「偙偺搙偼」「僇儊儔」这种看着像中文的假乱码。只按 GBK 试一定判错。实测日文 MMD readme 里 SHIFT_JIS 1269 个 vs GBK 396 个，反过来会全错。

## 转换

目标格式统一写 **UTF-8-BOM**（Windows 记事本 / Notepad++ / VS Code / 浏览器默认都认；纯 UTF-8 无 BOM 在中文 Windows 记事本里仍可能被猜成 GBK）。

```
data = b'\xEF\xBB\xBF' + text.replace('\r\n', '\n').encode('utf-8')
```

## 绝对不要转的

- **二进制**按扩展名硬排除：`.docx .pdf .jpg .png .vmd .pmx .zip .mp4 .ttf` 等。文件名带「readme」也照样排除（`readme.pdf` / `Read me!.docx` 很常见）
- **.fx 着色器**：MME 按系统代码页读，改成 UTF-8-BOM 会加载失败
- 含 NUL 字节占比 > 5% 且非 UTF-16 的，一律当二进制

## 工具

`D:\用户\工具\fix-encoding.py`（8.4 KB，只用标准库，任何 Python 3 都能跑；python 解释器在 `D:\用户\工具\pythons\cpython-3.12.15-windows-x86_64-none\python.exe`，不在 PATH）：

```
python fix-encoding.py "D:/某个目录"                          # 只扫描出报告
python fix-encoding.py "D:/某个目录" --go                     # 原地转（自动全量备份）
python fix-encoding.py "D:/某个目录" --go --mirror "D:/out"   # 结果写到别处，原目录不动
python fix-encoding.py "D:/某个目录" --ext txt,srt,md         # 只处理指定扩展名
```

本机 Python：`D:/DSH/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe`

## 已知残留

`UNKNOWN` 多半是 docx/pdf/jpg 伪装成 readme（已在 BINARY_EXT 里排除），或者混合编码文件。不要为它们做启发式猜测。

## 相关：装字体（解决缺字形）

- 系统字体目录 `C:\Windows\Fonts`，注册表 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts`
- 拷贝后必须 `AddFontResource` + 广播 `WM_FONTCHANGE`（`SendMessage(0xffff, 0x001D, 0, 0)`）才立刻生效
- `Add-Type -PassThru` 返回的是**类型数组**，`$F::Method()` 会报「FileInfo does not contain a method」—— 改用固定类型名 `[Win32b.FontNotify2]::AddFontResource()`
- 注册表键名用 `族名 字重 (TrueType)`（如 `Noto Sans SC Bold (TrueType)`），值 = 文件名
