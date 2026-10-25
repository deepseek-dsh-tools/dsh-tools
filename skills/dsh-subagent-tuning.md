---
name: "dsh-subagent-tuning"
description: "子智能体与 teammate 的 preset/成本调优：standard 比 ptc 省 73%，teammate 为什么贵 3.5 倍、能不能单独降、槽位怎么回收。"
whenToUse: "要派子智能体/teammate、或关心委派成本时"
metadata:
  managed: true
  source: "model"
---

# 子智能体与 teammate 成本

## 硬数据（2026-10-18 实测）
- 子智能体默认 preset **ptc = 32.7K tok/轮** system prompt；**standard = 2.3K tok**，差 **14 倍**。75% 是 PTC 的 `## Writing code for run_code` 段（98,666 字符，仅 `tools.mode === "ptc"` 时由 `@deepseek-ai/dsh-tools` 注册）。
- 子智能体是全新 session → cached=0，每轮全价重付。
- **已改**：profile patch 里 `tool-subagent` 加 `agentPreset: standard` + `allowedAgentPresets: [standard, minimal, ptc]`。重启后实测 system prompt **130,577 → 34,455 字符（−73.6%）**。
- 需要 PTC 子智能体时在 `subagent` 调用里显式传 `agent_preset: "ptc"`。

## 关键坑
- `applyEntryPatches` 对 `config` 是**整键替换**，不递归进 `config.plugins`（递归条件只有 `entry.group && Array.isArray(entry.config)`）→ 覆盖 preset 必须全量写出。
- **live 重载 ≠ 运行时生效**：patch 写入后 `cordis.yml` 立刻重新合成，但 preset 在启动时挂载，**必须重启桌面端**。
- 生成方式：从 `D:\DSH\resources\app\dsh\node_modules\@deepseek-ai\dsh-web-app\presets\ptc.patch.yml` 文本级提取，脚本 `D:\DSH_Home\.DSH\cache\probe-agnes\apply-preset-override.mjs`（不带 target 参数 = dry run）。

## teammate 为什么贵、能不能单独降
- teammate 不走 `tool-subagent`，走 `@deepseek-ai/dsh-experimental-tool-agent-team`；`spawnTeammate`（`lib/index.js:1507`）→ `roster.spawn` 不传 preset → 用全局 `defaultId`。
- `dsh-agent-preset-registry/lib/index.js:464`：`get defaultId() { return this.config.selectedDefault.get() ?? this.config.default; }`。
- **不能单独降**：改 `selectedDefault` 对所有新建会话生效，lead 自己也会掉到 standard。结论：维持现状。

## 用法分工
- 批量/一次性 → `subagent`（8.6K tok）
- 需要反复派活 → `teammate`（30.5K tok，可 send_message / interrupt_agent）

## 槽位回收
子智能体槽位自动回收（`dsh-subagent/lib/index.js:1046` `ActivationPool.reserve`），完成即释放；上限是"同时活跃数"（`maxActiveSubagents` default 8），超限立即报错不排队。`subagent` 不可复用，`teammate` 可反复 `send_message`。

## 验证法子
`D:\DSH_Home\.DSH\cache\probe-agnes\check-sub.mjs <subagentId>` 读它的 session（多帧 zstd）算 system prompt 字符数。
