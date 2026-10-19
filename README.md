# dsh-tools

曹操丕（@deepseek-dsh-tools）自用的 DeepSeek Harness 工具集。

不是框架、不是插件市场包 —— 全是日常在这台机器上真跑起来的东西，做的时候踩过的坑一并记在里面。

## 目录

| 目录 | 干什么的 |
| --- | --- |
| [`mode-switch/`](mode-switch/) | 按工作场景开关 DSH 工具家族，省 token。patch 里放 `!!js` 表达式在装配时读 `state.json` 求值，零运行期开销 |
| [`bili-db-maintain/`](bili-db-maintain/) | billion-context 的 `index.db` 维护器。到 1 GiB 才触发：删孤儿 content → `incremental_vacuum` 分批回收 → integrity_check → 留 2 份备份 |
| [`dsh-patches/`](dsh-patches/) | DSH 升级/插件更新后要重打的补丁脚本（幂等，可重复跑） |
| [`skills/`](skills/) | 自写的 DSH 技能文件（`.md`，扔进 `D:\\DSH\\.dsh\\skills\\` 生效） |
| [`memory-tool/`](memory-tool/) | 跨会话记忆的查看/修改 CLI（node:sqlite 直连 `memory-core.db`） |

## 环境前提

- **Windows**（这些工具大量依赖 Win32 路径、计划任务、PowerShell 编码行为）
- **DSH**（DeepSeek Harness）桌面版，profile 默认 `desktop`
- `mode-switch` 需要 DSH 自带 node；`bili-db-maintain` 需要任意 Python 3.8+
- 路径里的 `D:\\DSH\`、`D:\\用户\` 是本机布局，换机器要改常量

## 几条踩出来的铁律

这些不是教科书抄来的，是真上机跑崩后总结的：

1. **Windows 计划任务里的 `.cmd` 永远按 ANSI(GBK) 逐字节读**，UTF-8 无 BOM 的中文路径会被解成乱码。要么写 GBK，要么开头 `chcp 65001 >nul`。`.ps1` 相反 —— 必须带 BOM。
2. **cmd 重定向从左往右生效**：`2>&1 >> file` 会把 stderr 全丢到控制台、文件 0 字节。要捕获必须 `>> file 2>&1`。
3. **网页自动化点击必须走真实事件**（CDP 的 click/press），JS 派发 `MouseEvent` 会被反作弊（Verisoul 之类）识破；浮层挡住时改走键盘 Tab+Enter，键盘事件不过 `elementFromPoint`。
4. **SQLite 大库不要整库 VACUUM** —— 1 GB 要 10–15 秒，超过连接池的 busy_timeout 就刷 SQLITE_BUSY。用 `PRAGMA auto_vacuum=INCREMENTAL` + 分页 `incremental_vacuum`，单批能压到 250 ms 以内。
5. **DSH patch 里的 `!!js` 表达式**：路径必须写成正斜杠，否则 `\\D` `\\.` 不是合法转义 → 路径变形 → 读文件抛错 → 退化成"全开"。表面全绿其实没生效。

## 许可

MIT
