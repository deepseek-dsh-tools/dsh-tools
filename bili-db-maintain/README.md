# bili index.db 维护器

**做什么**：bili（billion-context）的会话索引库 `index.db` 会随历史增长。它自己在删会话时才会回收 `content` 表里 `refcount<=0` 的孤儿 blob，但从不 VACUUM，所以删掉的空间变成空闲页留在文件里。这套脚本在库达到阈值时做一次「删孤儿 + VACUUM」，把文件真正缩小。

**阈值**：1 GiB（`--threshold-mb 1024`）。

## 为什么 1 GiB 不影响性能

实测（200 次平均，sqlite3 直连只读）：

| 操作 | 196 MB 库 | 147 MB 库 |
|---|---|---|
| 主键查 content | 0.036 ms | 0.004 ms |
| session+seq 查 messages | 0.004 ms | 0.004 ms |
| count(messages) | 0.025 ms | 0.016 ms |
| content 全表扫描（最坏） | 36.1 ms | 22.8 ms |

正常读路径全走主键/索引，跟文件大小无关。**唯一随体积线性增长的是全表扫描**，而它只出现在统计类查询里。所以 1 GiB 完全在安全区。

## VACUUM 耗时会随体积涨

在真库副本上灌到 1.2 GB 实测：

| 库大小 | DELETE 孤儿 | VACUUM | integrity_check |
|---|---|---|---|
| 198.9 MB（真实数据） | 0.79 s | 1.64 s | 0.24 s |
| 1.2 GB（1000 条 1MB blob 实数据） | 0.16 s | **12.1 s** | 1.32 s |
| 1.15 GB（950 条全孤儿） | 1.14 s | 1.68 s | — |

VACUUM 要重写整库，1 GB 约 10–15 秒。这期间 sqlite 持有独占锁；bili 侧的 `busy_timeout` 是 **5000 ms**（`dist/index.js` @1532223），我们的脚本设 **30000 ms**。**若 VACUUM 超过 5 秒，bili 那次写会报 SQLITE_BUSY 并在下个请求重试**，不会丢数据但可能刷一条 warn。这是选择「1 GiB 才做、每次只几秒」而不是「频繁小压缩」的原因。

## 用法

```
python maintain.py check                  # 只体检，不动数据（退出码 10 = 已超阈值）
python maintain.py vacuum                 # 超阈值才执行
python maintain.py vacuum --force         # 忽略阈值强制执行
python maintain.py vacuum --threshold-mb 2048
```

## vacuum 的执行顺序

1. 读当前大小，未达阈值 → 直接退出（`[skip]`）。
2. 可回收空间 < 8 MB → 跳过（VACUUM 要重写整库，不值当）。
3. **用 sqlite3 backup API 做一致性快照**到 `backups/index-<时间戳>.db`（在线安全，不停 bili；198 MB 约 0.8 s）。
4. `DELETE FROM content WHERE refcount <= 0` —— 与 bili 自己 `dist/index.js` @2927768 / @2932407 的 GC 语句完全一致。
5. `VACUUM`。
6. `PRAGMA integrity_check`，不是 `ok` 则报错退出（原库不会被破坏，VACUUM 是原子的）。
7. `PRAGMA wal_checkpoint(TRUNCATE)`。
8. 只保留最近 2 份备份，更早的删除。

## 自动执行

Windows 计划任务 `bili-db-maintain`：
- 触发器：**登录时** + **每天 04:17**
- 动作：`powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File run.ps1`
- 运行身份：当前用户、交互式、Limited（不需要管理员）
- 执行时限 30 分钟，`MultipleInstances=IgnoreNew`
- `StartWhenAvailable`（错过的触发在下次开机补跑）

日志：`task.log`（每次触发追加一段，含时间戳与退出码）。

## 文件

| 文件 | 作用 |
|---|---|
| `maintain.py` | 主脚本（check / vacuum） |
| `run.ps1` | 计划任务包装。**必须存成 UTF-8 带 BOM**，否则 PowerShell 5.1 按 GBK 读会把中文路径读成乱码 |
| `task.log` | 每次触发的结果 |
| `maintain.log` | python 侧自己的追加日志 |
| `backups/` | VACUUM 前的一致性快照，保留 2 份 |

## 坑（已踩过）

1. **`run.cmd` 不能用 —— 真正原因是编码，不是引号**（2026-10-19 用 11 个计划任务逐个实测推翻原判断）：

   ``.cmd` 由 `cmd.exe` 用**当前 ANSI 代码页逐字节读**，永不识别 UTF-8。计划任务里代码页实测是 **936（GBK）**（`chcp` 在任务里输出 `活动代码页: 936`）。所以 UTF-8 无 BOM 写的 `.cmd` 里那句 `D:\用户\工具\pythons\...\python.exe` 的 UTF-8 字节被当 GBK 解释 → 路径不存在 → stderr 报 `系统找不到指定的路径。`、`ERRORLEVEL=3`。

   而重定向又写成 `2>&1 >> "task.log"`。cmd 的重定向是**从左往右依次生效**：先把 stderr 复制到当时的 stdout（= 控制台），再把 stdout 指向文件 → **stderr 全落到控制台，文件里一个字都没有**。这就是"0 字节日志 + 看起来静默退出"的由来。

   实测对照（全部真计划任务跑，`Limited` + `Interactive`）：

   | 变体 | 编码 | 内容 | 结果 |
   |---|---|---|---|
   | `orig.cmd` | UTF-8 无 BOM | `set PY="中文路径"` + `2>&1 >> log` | **LastResult=1，log 0 字节**（复现原故障） |
   | `bom.cmd` | UTF-8 **带 BOM** | 同上 | **LastResult=1，log 0 字节**（BOM 3 字节被当命令，更糟） |
   | `gbk2.cmd` | **GBK** | 同上 | **LastResult=0，log 387 字节，正常** |
   | `quote.cmd` | GBK | `set PY="..."` 保留双引号 | **LastResult=0，EXIT=0** ← 引号根本不是问题 |
   | `u8c.cmd` | UTF-8 无 BOM | 开头加 `chcp 65001 >nul` | **LastResult=0** ← 改代码页也行 |

   → **结论：`set PY="..."` 带引号完全无害（`%PY%` 展开成 `"路径"` 正是正确用法）。原判断"退化成裸 python.exe 进 REPL"是错的。**
   → 要让 `.cmd` 能用：写成 **GBK 编码**，或在第一行后加 `chcp 65001 >nul`，或全程用 ASCII 路径。**UTF-8 加 BOM 在 `.cmd` 里是毒药**（与 `.ps1` 正好相反：PS 无 BOM 按 ANSI 读所以要 BOM，cmd 永远按 ANSI 读所以不能有 BOM）。

   实际上最终选了 `.ps1`，但理由是**它不需要中文路径编码折腾 + 能直接用 `$LASTEXITCODE` 和 `Out-File -Encoding utf8`**，不是为了绕开引号。
2. **`run.ps1` 必须带 BOM**：PowerShell 5.1 对无 BOM 的 `.ps1` 按系统 ANSI（GBK）解析，`D:\用户\工具\...` 里的中文目录名会被读成 `D:\鐢ㄦ埛\宸ュ叿\...` → 「无法将...项识别为 cmdlet」。用 `0xEF 0xBB 0xBF` 开头写。
3. **python 输出要用 UTF-8**：包装脚本里加 `$env:PYTHONIOENCODING='utf-8'` + `[Console]::OutputEncoding=[Text.Encoding]::UTF8`，否则 `[skip] 151.6 MB < 阈值` 写进日志是 `闃堝€?`。

3b. **重定向顺序**：`2>&1 >> file` 会丢掉 stderr（先复制 stderr 到控制台，再重定向 stdout）；要捕获 stderr 必须写 `>> file 2>&1`。实测：同一条 python 往 stderr 写一行，`2>&1 >> ord1.txt` 得 0 字节，`>> ord2.txt 2>&1` 得 10 字节。
4. **`bili.log` 的 10 MB 轮转改不了**：`dist/index.js` @1523733 `var MAX_BYTES=10*1024*1024` 是硬编码常量，无环境变量无配置项。要改只能 patch 插件本体（不值得，10 MB 自动轮转 + 保留一份 `.old` 已经够用）。

## 回滚

任一份 `backups/index-*.db` 覆盖回 `%USERPROFILE%\.local\share\billion-context\sessions\index.db` 即可（先停 bili 或让它空闲）。删掉计划任务：`Unregister-ScheduledTask -TaskName 'bili-db-maintain' -Confirm:$false`。
