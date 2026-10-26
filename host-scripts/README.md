# host-scripts —— `D:\用户\工具\` 根脚本的镜像

这些脚本的**真身**在 `D:\用户\工具\` 根目录下（`D:\DSH_Home\.DSH` 里的计划任务与插件配置写死了那条路径，
搬走会让任务静默失效），这里存的是**副本**：本机盘坏了、误删了，还能从这里拿回来一份。

## 同步

```bash
node D:\用户\代码\dsh-tools\host-scripts\sync-host-scripts.mjs          # 预演：只报差异
node D:\用户\代码\dsh-tools\host-scripts\sync-host-scripts.mjs --apply  # 真同步（真身 → 这里）
```

方向是**单向**的：`D:\用户\工具\` 是源（真身），这里是镜像。改了这里的文件不会影响正在跑的任务。

## 清单（15 个）

| 文件 | 干什么 | 谁在用 |
|---|---|---|
| `daily-backup.mjs` | 每日备份四段流水（会话导入 → 念库 reindex+export → 插件快照 → git bundle，保留 7 份） | 计划任务 `soul-daily-backup` |
| `dsh-auth-cookie-guard.ps1` / `.vbs` | 登录 cookie 守卫（cookie 预算 12000 字节，超了清） | 计划任务 `dsh-auth-cookie-guard`（`wscript.exe` 静默启动） |
| `dsh-auth-cookie-doctor.py` / `.cmd` | cookie 体检与修复；`.cmd` 是给人点的人工入口 | `工具\tests\test_auth_cookie_doctor.py` |
| `dsh-bili-clean.ps1` / `.vbs` | bili 压缩代理缓存清理 | 计划任务 `dsh-bili-clean` |
| `fix-memory-order.mjs` + `verify-mem-order.mjs` | `memory-core` 的 renderBlock 顺序补丁（幂等；插件升级会覆盖 → 必须重跑） | 常驻记忆条目 |
| `fix-raccoon-context.mjs` | raccoon 渠道上下文窗口修正 | — |
| `fix-raccoon-vision.mjs` | raccoon「模型不支持图片输入」白名单补丁（剥 id 尾部 `-数字`） | 常驻记忆条目 |
| `fix-encoding.py` | 文本编码批量诊断/转换（判序：cp932 必须早于 gbk） | 技能 `windows-text-encoding-fix` |
| `push-all-repos.mjs` | 批量推 GitHub（SSH key `D:/用户/.gh-keys/gh_key`，需 `HOME=D:\用户`） | 手动 |
| `sync-agents.mjs` | AGENTS.md 真身（念库）→ 工作区符号链接的守卫 | 计划任务 `soul-skills-sync` 第二 action |
| `sync-skills.mjs` | 念 `技能/` ↔ DSH `skills/` 符号链接同步 | 计划任务 `soul-skills-sync` 第一 action |

**没有镜像**：`dsh-auth-cookie-guard.log`、`dsh-bili-clean.log`（运行产物）、以及 `工具\` 下所有目录
（`屏幕视觉`、`dsh-plugins`、`pythons`、`models` 等是可重装的二进制/数据，另有各自的备份路径）。

## 注意

- `.vbs` 两个文件是 **GBK** 编码（`wscript.exe` 按 ANSI 代码页读），不要转成 UTF-8。
- 这些脚本里含**本机路径**（`D:\用户\...`、`C:\Users\z1366\...`）—— 仓库是 private，按 2026-10-26 的决定不打码。
- 这里只有 15 个根脚本；`工具\` 下的工程与数据（约 6 GB）不在这里，见 `念\状态\环境.md`。
