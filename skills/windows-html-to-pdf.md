---
name: "windows-html-to-pdf"
description: "Windows 上把 HTML/Office 文档转 PDF 或预览图：docx/xlsx/pptx 走 DSH 自带的 LibreOffice Kit CLI（不用装任何软件），HTML 走 Edge headless 打印。"
whenToUse: "要把 docx/xlsx/pptx/HTML 转成 PDF，或要把文档渲染成 PNG 检查版面时"
metadata:
  managed: true
  source: "model"
---

# 文档 → PDF / PNG（Windows）

## 两条路，先选对

| 源文件 | 用什么 | 命令 |
|---|---|---|
| **docx / xlsx / pptx / odt** | **DSH 自带 LibreOffice Kit**（首选） | `"<node>" "<cli>" convert --input X --output Y.pdf` |
| HTML / 纯网页 | Edge headless 打印 | 见下「Edge 打印」 |

**不要再写「本机没装 LibreOffice」**——系统里确实没有 `soffice.exe`，但 DSH 内嵌了一整套 **LibreOffice Kit 0.1.5**（184 MB 便携版 + 自带 native CLI），2026-10-19 实测可用。

## 路径（都是 D 盘，别猜）

```
NODE = D:/DSH/resources/runtime/primary-runtime/dependencies/node/bin/node.exe
CLI  = D:/DSH/resources/app/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js
KIT  = D:/DSH/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/libreoffice-kit.exe  (178 MB)
```

Bash 引号写法：`"$NODE" "$CLI" convert --input "D:/a.docx" --output "D:/a.pdf"`

## 三个子命令（实测）

### convert —— 转 PDF
```bash
"<node>" "<cli>" convert --input X.docx --output Y.pdf
# 返回 {"backend":"native","missingFonts":["Courier"],"outputPath":"D:\...\Y.pdf"}
```
- 实测 **1.9 秒**，输出 `%PDF-1.7`，中文渲染正常（宋体系）
- `missingFonts` 列表不阻断；本机常见缺 `Courier`（等宽字体），要精确等宽就改用 `Consolas`/`Courier New`

### render —— 出 PNG 看版面（检查排版神器）
```bash
"<node>" "<cli>" render --input X.docx --output-dir DIR
# 参数是 --output-dir，传 --output 会报 "render requires --output-dir and does not accept --output."
```
- 输出 `DIR/page-0001.png` 起，**144 dpi / A4 时 1224×1584**，附 `manifest.json`（含 pageCount / sha256 / dpi）
- PDF 走 `pdfium`，Office 文档走 `libreoffice` 光栅引擎；1.7 秒出两页
- 支持直接渲染 docx（不用先转 PDF），检查「有没有挤到第 2 页」「日期有没有跑出纸外」一眼就看出来

### recalculate —— 刷 xlsx 公式缓存
```bash
"<node>" "<cli>" recalculate --input X.xlsx --output Y.xlsx
# --input 和 --output 都必填，缺一个报 "--input and --output are required."
```
openpyxl 写出的 `=SUM(A1:A2)` 没有缓存值，别的程序读会得到 None —— 用这个刷一遍。

## 关键坑

- **没有 `--help` / `--version`**：两个都报 `Unknown option`。别浪费一次调用。
- 子命令参数名各不相同：convert 用 `--output`，render 用 `--output-dir`，recalculate 用 `--output`。
- 路径用**正斜杠**（`D:/用户/...`），中文路径可直传，不用转义。
- 返回是 JSON 字符串，成功看 `outputPath` 有没有值；失败是 `{"code":"failed","error":"..."}`。

## Edge 打印（HTML → PDF / 截图）

只有源是 HTML 才用这条。**必须 PowerShell `Start-Process -Wait`，bash 直调会静默失败（exit 0、无文件、无 stderr）**。

```powershell
Start-Process -FilePath "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" -ArgumentList @(
 "--headless=new","--disable-gpu","--no-sandbox","--no-first-run","--no-default-browser-check",
 "--disable-extensions","--run-all-compositor-stages-before-draw","--virtual-time-budget=6000",
 "--print-to-pdf=$pdf","--no-pdf-header-footer",$uri) -Wait -WindowStyle Hidden
```
截图换成 `--hide-scrollbars --window-size=900,1250 --virtual-time-budget=5000 --screenshot=$png`。
URL 必须 `file:///D:/...`（正斜杠，中文路径可直传）。

## HTML 版面坑（做简历踩过的）

- `@page { margin }` **只管打印不管屏幕** → 加 `@media screen { body { padding: 13mm 14mm; box-sizing: border-box; } }`，否则预览图贴边看着像排版崩了
- `display:flex; justify-content:space-between` 会把右侧日期**挤出纸外** → 改 `.row { position:relative; padding-right:140px; min-height:1.35em; }` + `.when { position:absolute; right:0; top:0; }`
- **同一份内容，HTML 打印 1 页、docx 转出来 2 页**是正常的（样式不同）。要单页就得压 `font-size`/`line-height`/`@page margin`，改完用 `render` 数 `pageCount` 验证，别猜。

## 校验（省事版）

有 kit 之后不用手搓 zlib 数 TJ 了：`render` 的 `manifest.json` 直接给 `pageCount`。
真要读 PDF 文本又没有 pypdf 时，才退回 `re.findall(rb"/Count\s+(\d+)", data)` + `zlib.decompress` 的土办法。

## python-docx（造 docx 用）

`D:/DSH/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe` —— 有 python-docx / Pillow / openpyxl；**没有 reportlab / pymupdf / pypdf**。
