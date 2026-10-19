---
name: "dsh-safe-change"
description: "修改 D:\\DSH 下任何插件/配置/提示词前必走的四段验证流程（备份→语法→import→headless），防止把宿主弄到起不来。"
whenToUse: "要动 D:\\DSH 里的文件、patch、插件代码、提示词前"
metadata:
  managed: true
  source: "model"
---

# 改 D:\DSH 的安全流程

## 四段验证（四条全绿才算完）
工具在 `D:\DSH\.dsh\cache\safe-change\`：

1. `safe-change.cmd all "<文件或目录>"` —— 改前备份 + 语法检查
2. 改
3. `check` —— JS 语法 / YAML 校验
4. `import "<插件入口 js>"` —— 在真实 Electron Node 里 import
5. `headless "回答一个字：好"` —— 独立进程跑完整一轮

任一步红 → `restore "<backups\时间戳目录>"` 回滚，别让用户重启去踩坑。

## 提示词/装配类改动另加一步
`persona*`、`system-prompt`、`{{变量}}` 这类改动，还要按 `cache\verify-*.mjs` 的写法复刻宿主装配跑一遍。

## 纪律
- 一次只改一个逻辑单元，改完立刻验证
- 原始文件先读后写
- 跑 headless 前必须显式带 `DSH_HOME=D:/DSH/.dsh`，否则会话历史落到 `C:\Users\z1366\.dsh`

## 背景
2026-10-17 装 dsh-purge 后提示词抛 `unknown prompt variable "{{cwd}}"`、整轮对话失败。这套流程就是为了拦住这类事。
