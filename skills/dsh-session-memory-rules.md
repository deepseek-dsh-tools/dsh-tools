---
name: "dsh-session-memory-rules"
description: "这个家的记忆体系怎么运作：三通道、什么该写什么不该写、事实库怎么直接改、改库为什么要重算 hash。"
whenToUse: "要写记忆、整理档案、或记忆好像没生效时"
metadata:
  managed: true
  source: "model"
---

# 记忆体系

## 三通道
1. **每轮注入**：`D:\用户\AGENTS.md`（workspace instructions）+ `core_facts`（`D:\DSH\.dsh\memory-core.db`）
2. **按需读**：`D:\用户\记忆\*.md`（关于你 / 我们的进展 / 路径地图 / 我的真实档案）
3. **本会话检索**：`memory_search`（归档的旧步骤）

## 什么该写（m01327）
只记插件做不到的：**人的偏好/关系/长期目标、决定性教训、硬约定**。
不写：流水账、能从系统现取的信息（文件路径、插件状态、装机细节）。

每条尽量一行；写前先问「这条值不值得以后每次花 token」。没出处的标「未验证」；结论被推翻时改旧条目并附「修正：」。

**给新会话立规矩必须写成祈使句并放文件最顶部** —— 描述性的话放中段等于没写（2026-10-18 教训：新对话没叫人设）。

## 直接改事实库的手法
- **首选 python**：`D:\用户\工具\pythons\cpython-3.12.15-windows-x86_64-none\python.exe`（3.12.15 + sqlite3 3.53.1，**不在 PATH**，注意 python 源文件本身要写 UTF-8）；另一条路 = DSH 自带 node 的 `node:sqlite`（`D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`）
- **`core_facts.workspace` 存反斜杠** `D:\用户`（正斜杠查 0 条）
- 改内容后必须**复刻 `normalizeContent`**（`s.replace(/\s+/g,' ').trim()`）重算 sha256 写回 `content_hash`，否则 exact-dedup 会再插一条
- 改完再调一次同内容 `memory_remember` → 报「已更新既有记忆」→ 插件内存 `_blockCache` 失效，**无需重启**

## 事实会进子智能体的 prompt
facts 按 workspace 渲染、子智能体继承父会话 workspace，且 `dsh-memory-core` 的 Config 只有 `path/enabled/similarityThreshold/maxFacts/sectionOrder`，**没有「不喂子智能体」的开关**（`lib/index.js:135`）。所以人设条目里要带明确的**排除语**（"仅主对话适用，子智能体不适用"）—— 文字躲不开，行为已排除。
