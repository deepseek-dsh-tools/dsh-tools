# mode-switch —— 按工作场景开关 DSH 工具家族

**一句话**：切一次模式只写一个 JSON 文件，patch 里的开关是 `!!js` 表达式、装配时读那个 JSON 求值。
所以**手动切**和**开机自动恢复**是同一套机制 —— 上次切到哪个模式，下次开 DSH 就自动是哪个，零额外开销。

## 用法

```
D:\DSH_Home\.DSH\cache\mode-switch\mode.cmd list         # 看模式与家族
D:\DSH_Home\.DSH\cache\mode-switch\mode.cmd status       # 当前模式 / 谁被关了
D:\DSH_Home\.DSH\cache\mode-switch\mode.cmd web -n       # 预览，不写任何文件
D:\DSH_Home\.DSH\cache\mode-switch\mode.cmd web          # 真切换
D:\DSH_Home\.DSH\cache\mode-switch\mode.cmd verify       # 校验当前模式（22 项）
D:\DSH_Home\.DSH\cache\mode-switch\mode.cmd verify dev   # 校验某个模式（只模拟，不改状态）
D:\DSH_Home\.DSH\cache\mode-switch\mode.cmd log          # 切换记录（时间/切到/从哪来/间隔）
D:\DSH_Home\.DSH\cache\mode-switch\mode.cmd web --force      # 越过防抖强制切
```

**切模式是花钱的动作**：patch 一变宿主就重新装配、系统提示整段换掉，下一次请求的**全部历史**
按新前缀重算。实测重写代价 ≈ 当时的历史 token 数（历史 396K 时切一次 396K，刚压缩完 21K 时切一次
14.2K）。所以：**要连切几个就一次切到位；刚压缩完（历史最小）时切最省。**

## 模式

| 模式 | 开着的家族 | 用途 |
|---|---|---|
| `web` | browser | 纯网页 / 浏览器作业 |
| `blender` | blender | 建模 / 渲染 |
| `dev` | browser + team | 写代码 + 派子智能体 |
| `full` | 全开 | 安全基线（等于没开关） |
| `minimal` | 无 | 只剩 shell / 文件 / 记忆 / undo |

## 家族与代价

| 家族 | loader id | ≈tok/请求 |
|---|---|---|
| blender | `dsh-blender-plugin` | 4841 |
| browser | `browserskill` | 5474 |
| team | `agent-team` `tool-agent-team` `ui-agent-team` | 4045 |
| doublecheck | `doublecheck-grill` `doublecheck-guard` | 1410 |
| computer | `computer-use` | 2038 |

`web` 关掉 blender/team/doublecheck/computer = **省 ≈12,334 tok / 请求**。

## 机制（四条必须知道）

### 1. 状态在 state.json，不在 patch 里

`D:\DSH_Home\.DSH\cache\mode-switch\state.json`：

```json
{ "mode": "web", "on": ["browser"], "ts": "2026-10-19T06:47:51.834Z", "from": "full" }
```

`ts` 是上次切换时间，`from` 是切换前的模式 —— 后者专给防抖用（判断「是不是刚从这个模式切走」）。

patch 末尾那段（`# >>> MODE-SWITCH BEGIN` … `END`）的每一行 `disabled` 都是一个 `!!js` 表达式：

```js
(() => { try {
  const fs = process.getBuiltinModule('fs');
  const st = JSON.parse(fs.readFileSync('D:/DSH_Home/.DSH/cache/mode-switch/state.json', 'utf8'));
  const on = Array.isArray(st.on) ? st.on : ["blender","browser","team","doublecheck","computer"];
  return on.indexOf("blender") < 0;     // 不在 on 列表里 → 禁用
} catch (e) { return false; } })()      // 读不到/坏掉 → 不禁用（退化全开）
```

求值实现在 `@deepseek-ai/cordis-plugin-loader`：`new Function('ctx','expr',`with (ctx) { return eval(expr) }`)`。
**只在装配时跑一次**，跑完就没了，没有任何运行期开销。

### 2. 路径必须写正斜杠

表达式文本会被塞进 YAML 块再当 JS 字符串求值。写成 `D:\DSH\...` 时
`\D \. \c` 都不是合法转义，路径会变形、读不到文件、走 catch 分支退化成**全开** ——
表面一切正常，其实模式根本没生效。这个 bug 本版已经踩过并修掉（`STATE_FWD`）。

### 3. 两条防「白切」机制

- **重复切同一模式 = 一个字节都不写**。旧版会照写新时间戳 → 白花一次全量前缀重写。现在先比
  `state.json` 里的 mode 与 on，完全一致就不碰 patch（要强改加 `--force`）。
- **A → B → A 的快速回弹会被拦下**（默认 120 秒窗口）。真实账单里 `#1724 → #1730` 相隔 43 秒
  反向切回同一对 hash，两次合计 76.7K tok 全废。正常换工作不受影响；确实要立刻回弹加 `--force`。

### 4. 关 team 必须补开 subagent 四行

`@deepseek-ai/dsh-experimental-agent-team-profile` 一装就把 base 的
`tool-subagent` / `tool-subagent-fork` / `tool-subagent-control` / `tool-subagent-list-agents`
四行 `disabled: true` 掉，换成自己的三件套。所以只关 `agent-team` 会把 subagent 一起弄没。
mode.mjs 关 team 时用**反向表达式**把这四行补开。

## 生效时机

- **新会话生效**。改完 patch 后宿主会在几秒内重写 `profiles/desktop/cordis.yml`（实测约 3 秒），
  **当前已跑的会话不动** —— 已挂载的 fiber 本轮不卸载。想让本会话立刻变，重启 DSH。
- 每次切换会更新 patch 里那行 `# 当前模式: xxx @ 时间戳`，靠内容变化触发重载（只改 mtime 不保险）。

## verify 检查什么（22 项）

0. **探针化**：12 条表达式里都必须含 state.json 的路径（否则下面会拿错文件求值）。
1. 12 条表达式：用 loader 同款求值器跑一遍，逐条核对 id 的 disabled 是否与目标模式一致。
   表达式来源是 **宿主真重写出来的 `cordis.yml`**，不是 patch —— 那才是实际执行的那份。
2. 5 个防抖用例：43 秒内回弹 / 超窗口 / 不是回弹 / 切同一模式 / 没有 state.json，判定必须对。
   防抖逻辑抽成纯函数 `bounceReason(cur, mode, now)`，直接喂假数据测，不碰任何文件。
3. 3 个负向用例：把 state.json 换成坏 JSON / 缺 on / on 不是数组，所有家族表达式必须退化成「不禁用」。
   防的是「表达式有 bug 但恰好和预期一致」的假绿。
4. 1 次真 `--dump-config`，抓 `patch: entry "X" not found` 警告 —— id 拼错**不会改退出码**，只能靠这步抓。

**求值一律走探针文件 `state.probe.json`**：把表达式文本里的 `state.json` 路径替换成探针路径再求值。
旧版是「临时改写 state.json + finally 还原」，中途 kill 掉进程会把模拟状态留在线上，而线上 state.json
正是宿主装配时会读的文件 —— 撞上热重载就会按模拟值装出错的模式。

## 回滚

```
mode.cmd full        # 全开，等于没开关
```
原始 patch 备份：`D:\DSH_Home\.DSH\cache\safe-change\backups\20261019-113954\cordis.patch.yml`
（把备份覆盖回 `profiles/desktop/cordis.patch.yml` 即彻底摘除）

## 已知限制

- patch 是 **profile 级全局**，不是会话级。开两个会话时它们共用同一份开关，切模式会一起变。
- 切换只影响**之后新装配**的会话；本会话的工具列表已定型。
- tok 数是按工具声明文本估的，实际省多少取决于会话长度（每请求都省，所以轮次越多省越多）。
