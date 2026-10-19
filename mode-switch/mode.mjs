#!/usr/bin/env node
/**
 * mode-switch —— 按工作场景开关 DSH 工具家族（省 token + 减少装配/注册开销）
 *
 * 【工作方式】patch 里的开关段不是静态 true/false，而是一串 !!js 表达式，
 * 每次 DSH 装配时读 state.json 求值。所以：
 *   · 手动切换 = 只写 state.json（+ touch patch 触发热重载）
 *   · 启动时自动恢复 = 天然实现，patch 一装配就按 state.json 来，零额外开销
 *   · state.json 缺失/损坏 → 表达式 catch 后返回「不禁用」，退化为全开（安全方向）
 *
 * 用法：
 *   mode.mjs list              列出模式与家族
 *   mode.mjs status            看当前模式（读 state.json）
 *   mode.mjs verify [模式]     本地逐条求值 !!js 表达式并核对 id/disabled
 *   mode.mjs <模式>            切换（-n 预览，--verify 切完校验）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BASE = 'D:/DSH/.dsh/cache/mode-switch';
const DSH_HOME = 'D:/DSH/.dsh';
const PROFILES = path.join(DSH_HOME, 'profiles');
const DESKTOP = path.join(PROFILES, 'desktop');
const PATCH = process.env.DSH_PROFILE_PATCH || path.join(DESKTOP, 'cordis.patch.yml');
const STATE = path.join(BASE, 'state.json');
const VERIFY_DIR = path.join(PROFILES, '_verify');
const DSH_EXE = 'D:/DSH/DeepSeek Harness.exe';
const DSH_CLI = 'D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
const BEGIN = '# >>> MODE-SWITCH BEGIN（mode.mjs 自动生成，别手改这一段） >>>';
const END = '# <<< MODE-SWITCH END <<<';

const FAMILIES = {
  blender: { label: 'Blender 建模/渲染', tok: 4841, ids: ['dsh-blender-plugin'] },
  browser: { label: '浏览器 bsk 操作', tok: 5474, ids: ['browserskill'] },
  team: {
    label: 'Agent Teams 委派', tok: 4045,
    ids: ['agent-team', 'tool-agent-team', 'ui-agent-team'],
    // team 关掉时必须把 base 自带的四条 subagent 打开，否则 subagent 家族整个消失
    offExtra: [
      { id: 'tool-subagent', disabled: false },
      { id: 'tool-subagent-fork', disabled: false },
      { id: 'tool-subagent-control', disabled: false },
      { id: 'tool-subagent-list-agents', disabled: false },
    ],
  },
  doublecheck: { label: 'doublecheck 规约门', tok: 1410, ids: ['doublecheck-grill', 'doublecheck-guard'] },
  computer: { label: 'Windows 桌面自动化', tok: 2038, ids: ['computer-use'] },
};

const MODES = {
  survey:  { on: ['browser'], desc: '问卷/网页作业' },
  blender: { on: ['blender'], desc: 'Blender 建模渲染' },
  dev:     { on: ['browser', 'team'], desc: '写代码 + 派子智能体' },
  full:    { on: ['blender', 'browser', 'team', 'doublecheck', 'computer'], desc: '全开（等于没开关）' },
  minimal: { on: [], desc: '最小：核心 shell / 文件 / 记忆 / undo' },
};

const ALL_FAMILIES = Object.keys(FAMILIES);

/** state.json 里 on 列表缺失/结构不对时的兜底：全开（安全方向） */
const FALLBACK_ON = ALL_FAMILIES;

/**
 * 生成一条 !!js disabled 表达式。invert=true 表示「家族开着时反而禁用」（team 的 offExtra 用）。
 *
 * 注意路径必须写成正斜杠：这段文本会被原样塞进 YAML 块再当 JS 求值，
 * 反斜杠在 JS 字符串里是转义符（\D \. \c 都不是合法转义，路径会变形读不到文件），
 * 一旦读文件抛错就会走 catch 分支退化成「全开」—— 看起来一切正常，其实模式没生效。
 */
const STATE_FWD = STATE.replace(/\\/g, '/');

/**
 * 探针状态文件。verify / trial 需要「假装 state.json 是别的模式」来求值，
 * 但线上那个 state.json 是宿主装配时真的会读的文件 —— 万一撞上热重载，
 * 就会按模拟值装出一个错的模式。所以这里把表达式里的路径字面量换成探针路径，
 * 让求值发生在探针上，线上 state.json 一个字节都不碰（见 evalExpr）。
 */
const PROBE = path.join(BASE, 'state.probe.json');
const PROBE_FWD = PROBE.replace(/\\/g, '/');

/**
 * 切换日志 —— 和 acp_cache 的 PROMPT SWITCHES 对表用。
 * 系统提示一变，整段历史都要按新前缀重算（实测重写代价 ≈ 当前历史全量：
 * 历史 396K 时切一次 396K，刚压缩完 21K 时切一次只有 14.2K），所以切换次数与时机都是钱。
 */
const LOG = path.join(BASE, 'switch.log');

/**
 * 防抖窗口。挡的是「A → B → A」的快速回弹 —— 真实账里 #1724 → #1730 相隔 43 秒
 * 反向切回同一对 hash，两次合计 76.7K tok 全废。正常换模式（A → B 停一会儿）不受影响，
 * 真要立刻回弹加 --force。
 */
const DEBOUNCE_MS = 120000;

function expr(fam, invert) {
  const test = 'Array.isArray(st.on) ? st.on : ' + JSON.stringify(FALLBACK_ON);
  const cond = invert ? 'on.indexOf(' + JSON.stringify(fam) + ') >= 0' : 'on.indexOf(' + JSON.stringify(fam) + ') < 0';
  return [
    '(() => { try {',
    "const fs = process.getBuiltinModule('fs');",
    "const st = JSON.parse(fs.readFileSync('" + STATE_FWD + "', 'utf8'));",
    'const on = ' + test + ';',
    'return ' + cond + ';',
    '} catch (e) { return ' + (invert ? 'true' : 'false') + '; } })()',
  ].join(' ');
}

/**
 * 生成开关段。除最后一行「当前模式」注释外完全恒定。
 * 那一行是有意为之：宿主按内容判断要不要重载，内容不变就不会重新装配，
 * 改了 state.json 也不会重新求值。所以每次切换都让这行带上时间戳。
 */
function buildBlock(mode, ts) {
  const rows = [
    BEGIN,
    '# 本段由 mode.mjs 生成，别手改。disabled 是 !!js 表达式，装配时读 state.json 求值。',
    '# 切换模式：mode.cmd <模式>   —— 只写 state.json，并靠下面那行时间戳触发热重载。',
    '# state.json 缺失或结构损坏时退化为「不禁用」（全开）。',
    '# 当前模式: ' + (mode || '(未知)') + ' @ ' + (ts || ''),
  ];
  for (const fam of ALL_FAMILIES) {
    const f = FAMILIES[fam];
    rows.push('# ' + fam + ' (' + f.label + ', ~' + f.tok + ' tok)');
    for (const id of f.ids) rows.push('- id: ' + id, '  disabled: !!js >-', '    ' + expr(fam, false));
    if (f.offExtra) {
      rows.push('# ' + fam + ' 关闭时的补偿：subagent 四件套反向开');
      for (const e of f.offExtra) rows.push('- id: ' + e.id, '  disabled: !!js >-', '    ' + expr(fam, true));
    }
  }
  rows.push(END);
  return rows.join('\n');
}

const readPatch = () => fs.readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');

function splitBlock(text) {
  const i = text.indexOf(BEGIN);
  if (i < 0) return { head: text.replace(/\s*$/, ''), block: null };
  const j = text.indexOf(END, i);
  if (j < 0) throw new Error('找到 BEGIN 但没找到 END，patch 文件被手动改坏了');
  return { head: text.slice(0, i).replace(/\s*$/, ''), block: text.slice(i, j + END.length) };
}

/** 重写整段开关段（带新的模式与时间戳）。返回是否真的动了文件。 */
function writeBlock(mode, ts) {
  const { head, block } = splitBlock(readPatch());
  const want = buildBlock(mode, ts);
  if (block === want) return false;
  fs.writeFileSync(PATCH, `${head}\n\n${want}\n`, 'utf8');
  return true;
}

/** 只在开关段缺失/被手改坏时补接线，保留现有模式与时间戳。 */
function writeBlockIfUnwired() {
  const { block } = splitBlock(readPatch());
  if (block && extractExprs(block).length >= 12) return false;
  const st = readState();
  writeBlock(st && st.mode ? st.mode : '(未知)', st && st.ts ? st.ts : '');
  return true;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}

function writeState(mode, extra) {
  const prev = readState();
  const from = prev && prev.mode && prev.mode !== mode ? prev.mode : (prev && prev.from) || null;
  const st = { mode, on: MODES[mode].on, ts: new Date().toISOString(), from, ...(extra || {}) };
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n', 'utf8');
  return st;
}

/** 记一行切换日志（含耗时口径：distance 距上次切多少毫秒） */
function logSwitch(mode, from, prevTs) {
  const now = Date.now();
  const gap = prevTs ? now - Date.parse(prevTs) : NaN;
  const line = [new Date(now).toISOString(), mode, from || '-', Number.isFinite(gap) ? Math.round(gap / 1000) + 's' : '-'].join('\t') + '\n';
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch {}
}

/**
 * 抽出所有 (id, 表达式文本)。
 * 不能假定 disabled 紧跟在 '- id:' 下一行 —— 合成树 cordis.yml 里中间还夹着 'name:' / 'config:'。
 * 所以按「从这个 - id: 到下一个顶层行」为一个条目块，在块内找 disabled: !!js >- 并收集它的缩进续行。
 */
function extractExprs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- id: *'?([^'\s]+)'?\s*$/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^- /.test(lines[j])) j++;
    const body = lines.slice(i + 1, j);
    for (let k = 0; k < body.length; k++) {
      if (!/^\s*disabled:\s*!!js\s*>?-?\s*$/.test(body[k])) continue;
      // 有 >- 表示下面缩进行是内容。续行缩进必须**比 disabled 行更深**，
      // 否则会把同级的 name:/config: 一起吃进来（YAML 折叠后拼成非法 JS）。
      const baseIndent = body[k].search(/\S/);
      let exprText = '';
      for (let q = k + 1; q < body.length; q++) {
        const line = body[q];
        if (!line.trim()) break;
        if (line.search(/\S/) <= baseIndent) break;
        exprText += (exprText ? ' ' : '') + line.trim();
      }
      if (exprText) out.push({ id: m[1], expr: exprText });
      break;
    }
    i = j - 1;
  }
  return out;
}

function status() {
  const st = readState();
  const block = splitBlock(readPatch()).block;
  const wired = block ? extractExprs(block).length : 0;
  const on = st && Array.isArray(st.on) ? st.on : FALLBACK_ON;
  const off = ALL_FAMILIES.filter((f) => !on.includes(f));
  return { st, on, off, wired, fallback: !(st && Array.isArray(st.on)) };
}

/**
 * 防抖判定（纯函数，verify 直接测它，不碰任何文件）。
 * 返回 null = 放行；返回字符串 = 拦下的理由。
 */
function bounceReason(cur, mode, now) {
  if (!cur || !cur.mode) return null;                 // 没有 state：放行
  if (cur.mode === mode) return null;                 // 切到同一个模式：writeBlock 会判无变化，不花重写
  if (!cur.from || cur.from !== mode) return null;    // 不是回弹：放行
  const gap = now - Date.parse(cur.ts || '');
  if (!Number.isFinite(gap) || gap > DEBOUNCE_MS) return null;
  return Math.round(gap / 1000) + ' 秒前刚从 ' + mode + ' 切到 ' + cur.mode;
}

function guardBounce(mode, force) {
  if (force) return;
  const why = bounceReason(readState(), mode, Date.now());
  if (why) throw new Error('防抖：' + why +
    '，现在切回去会让系统提示再重写一次（两次历史全废）。确实要切就加 --force。');
}

function apply(mode, dryRun, force) {
  if (!MODES[mode]) throw new Error('未知模式: ' + mode + '；可用: ' + Object.keys(MODES).join(' / '));
  guardBounce(mode, force);
  const savedTok = ALL_FAMILIES.filter((f) => !MODES[mode].on.includes(f)).reduce((s, f) => s + FAMILIES[f].tok, 0);
  if (dryRun) {
    console.log('--- dry-run：将写入 ' + STATE + ' ---');
    console.log(JSON.stringify({ mode, on: MODES[mode].on }, null, 2));
    console.log('--- 家族状态 ---');
    for (const f of ALL_FAMILIES) console.log('  ' + f.padEnd(12) + (MODES[mode].on.includes(f) ? 'ON ' : 'off') + '   ~' + FAMILIES[f].tok + ' tok');
    console.log('--- 预计省下 ' + savedTok + ' tok（单请求系统提示）---');
    return;
  }
  const prevSt = readState();

  // 已经是这个模式就一个字节都不写。
  // patch 里那行时间戳是「触发热重载」的开关，重写它 = 宿主重新装配 = 系统提示重写 = 全部历史重算。
  // 所以重复下同一个模式绝不能碰 patch（旧版会照写新时间戳，白花一次全量前缀）。
  const sameOn = prevSt && Array.isArray(prevSt.on) && JSON.stringify(prevSt.on) === JSON.stringify(MODES[mode].on);
  if (!force && prevSt && prevSt.mode === mode && sameOn) {
    const wired = extractExprs(splitBlock(readPatch()).block || '').length >= 12;
    if (wired) {
      console.log('已经是模式 ' + mode + '（' + MODES[mode].desc + '），patch 未动 —— 省下一次系统提示重写。');
      console.log('（要强制重写 patch 加 --force）');
      return;
    }
  }

  const prevTs = prevSt && prevSt.ts;
  const st = writeState(mode);
  const rewired = writeBlock(mode, st.ts);
  logSwitch(mode, st.from, prevTs);
  console.log('已切换到模式: ' + mode + '（' + MODES[mode].desc + '）');
  console.log('state: ' + STATE + '  on=[' + st.on.join(',') + ']');
  console.log('patch 开关段: ' + (rewired ? '已更新（时间戳变化触发热重载）' : '无变化'));
  console.log('关闭的家族: ' + (ALL_FAMILIES.filter((f) => !MODES[mode].on.includes(f)).join(', ') || '无') + '，预计省 ~' + savedTok + ' tok/请求');
  if (rewired) {
    // 提醒成本口径：这次切换的账单 ≈ 当前历史全量。历史 396K 时切一次 396K，刚压缩完 21K 时切一次 14.2K。
    console.log('\n注意：系统提示已变，下一次请求的全部历史按新前缀重算（≈ 当前历史 token 数）。');
    console.log('      看 acp_status 的 context 用量：历史小（刚压缩完）时切最省；要连切几个模式就一次切到位。');
  }
}

/**
 * 校验。分两层：
 *  1) 用 loader 一模一样的求值器（new Function('ctx','expr',`with (ctx) { return eval(expr) }`)）
 *     把合成树 cordis.yml 里的表达式跑一遍 —— 合成树是宿主真实重写出来的产物，
 *     它的表达式文本就是真 boot 会执行的那份，比读 patch 更贴近实际。
 *  2) 负向自检：把 state.json 临时写坏/清空 on，表达式必须全部退化成「不禁用」。
 *     这条防的是「表达式有 bug 但恰好和预期一致」这种假绿。
 */
function verify(mode) {
  if (mode && !MODES[mode]) throw new Error('未知模式: ' + mode + '；可用: ' + Object.keys(MODES).join(' / '));
  const prev = readState();
  const simMode = mode || (prev && prev.mode) || '(无)';
  const simOn = mode ? MODES[mode].on : (prev && Array.isArray(prev.on) ? prev.on : FALLBACK_ON);

  const composed = path.join(DESKTOP, 'cordis.yml');
  const src = fs.existsSync(composed) ? composed : PATCH;
  const found = extractExprs(fs.readFileSync(src, 'utf8'));
  if (!found.length) { console.log('✗ ' + src + ' 里没有 !!js 表达式，开关段没接线'); process.exit(1); }

  const bad = [];
  const lines = [];

  // loader 同款求值器
  const evaluate = new Function('ctx', 'expr', `with (ctx) { return eval(expr) }`);
  const ctx = { process: globalThis.process };

  // 求值一律发生在探针文件上：把表达式里的 STATE_FWD 字面量替换成 PROBE_FWD。
  // 线上 state.json 是宿主装配时真读的文件 —— 假装它是别的模式，万一撞上热重载
  // 就会按模拟值装出一个错的模式。换到探针上就一个字节都不碰（旧版改写 STATE + finally 还原，
  // 中途 kill 掉进程会把模拟状态留在线上）。
  const exprs = found.map((f) => ({
    id: f.id,
    expr: f.expr.split(STATE_FWD).join(PROBE_FWD),
    probed: f.expr.includes(STATE_FWD),
  }));
  const cleanupProbe = () => { try { fs.unlinkSync(PROBE); } catch {} };

  try {
    fs.mkdirSync(BASE, { recursive: true });

    // 层 0：所有表达式都必须指向 state.json（否则替换没生效，等于在测别的文件）
    const unprobed = exprs.filter((e) => !e.probed).map((e) => e.id);
    if (unprobed.length) bad.push('以下表达式里没有 state.json 路径，无法改用探针求值: ' + unprobed.join(', '));
    lines.push('  ' + (unprobed.length ? '✗' : '✓') + ' 探针化：' + (exprs.length - unprobed.length) + '/' + exprs.length + ' 条指向 state.probe.json');

    // 层 1：按目标模式求值，逐条核对
    fs.writeFileSync(PROBE, JSON.stringify({ mode: simMode, on: simOn }), 'utf8');
    const want = [];
    for (const fam of ALL_FAMILIES) {
      for (const id of FAMILIES[fam].ids) want.push({ id, fam, shouldOn: simOn.includes(fam) });
      // 补偿行与家族反着来：家族关着时它们必须开着（否则 subagent 家族整个消失）
      if (FAMILIES[fam].offExtra) for (const e of FAMILIES[fam].offExtra) want.push({ id: e.id, fam: fam + '/补', shouldOn: !simOn.includes(fam) });
    }
    const byId = new Map(exprs.map((e) => [e.id, e.expr]));
    for (const w of want) {
      const e = byId.get(w.id);
      if (!e) { bad.push(w.id + '（表达式里没有它的开关）'); continue; }
      let disabled;
      try { disabled = Boolean(evaluate(ctx, e)); } catch (err) { bad.push(w.id + '（求值抛错: ' + err.message + '）'); continue; }
      const eff = !disabled;
      const okFlag = eff === w.shouldOn;
      if (!okFlag) bad.push(w.id + '（期望 ' + (w.shouldOn ? 'ON' : 'off') + '，求值得 ' + (eff ? 'ON' : 'off') + '）');
      lines.push('  ' + (okFlag ? '✓' : '✗') + ' ' + w.id.padEnd(30) + (eff ? 'ON ' : 'off') + '  [' + w.fam + ']');
    }

    // 层 1.5：防抖判定（纯函数，直接喂假 state）
    const T0 = Date.parse('2026-10-19T12:00:00Z');
    const bounceCases = [
      { label: '43 秒内 A→B→A', cur: { mode: 'dev', from: 'survey', ts: new Date(T0).toISOString() }, to: 'survey', now: T0 + 43000, want: true },
      { label: '10 分钟前从 A 来（超窗口）', cur: { mode: 'dev', from: 'survey', ts: new Date(T0).toISOString() }, to: 'survey', now: T0 + 600000, want: false },
      { label: '不是回弹（从别的模式来）', cur: { mode: 'dev', from: 'blender', ts: new Date(T0).toISOString() }, to: 'survey', now: T0 + 1000, want: false },
      { label: '切到同一模式', cur: { mode: 'survey', from: 'dev', ts: new Date(T0).toISOString() }, to: 'survey', now: T0 + 1000, want: false },
      { label: '没有 state.json', cur: null, to: 'survey', now: T0, want: false },
    ];
    for (const c of bounceCases) {
      const hit = bounceReason(c.cur, c.to, c.now) !== null;
      const okFlag = hit === c.want;
      if (!okFlag) bad.push('防抖用例「' + c.label + '」期望 ' + (c.want ? '拦下' : '放行') + '，实得 ' + (hit ? '拦下' : '放行'));
      lines.push('  ' + (okFlag ? '✓' : '✗') + ' 防抖：' + c.label + ' → ' + (hit ? '拦下' : '放行'));
    }

    // 层 2：负向自检 —— state.json 坏掉时必须退化成全开
    const negCases = [
      { label: 'state.json 不是合法 JSON', body: '{ not json' },
      { label: 'state.json 缺 on 字段', body: JSON.stringify({ mode: 'x' }) },
      { label: 'state.json 的 on 不是数组', body: JSON.stringify({ mode: 'x', on: 'browser' }) },
    ];
    const famExprs = exprs.filter((f) => ALL_FAMILIES.some((fam) => FAMILIES[fam].ids.includes(f.id)));
    for (const c of negCases) {
      fs.writeFileSync(PROBE, c.body, 'utf8');
      let allOn = true;
      for (const f of famExprs) {
        let disabled;
        try { disabled = Boolean(evaluate(ctx, f.expr)); } catch { disabled = 'THROW'; }
        if (disabled !== false) { allOn = false; bad.push('负向「' + c.label + '」下 ' + f.id + ' 没退化成全开（得 ' + disabled + '）'); }
      }
      lines.push('  ' + (allOn ? '✓' : '✗') + ' 负向：' + c.label + ' → 退化成全开');
    }
  } finally {
    cleanupProbe();
  }

  // 层 3：拿 patch 走一次真 dump，确认 id 都存在于合成树（拼错只打 warning、退出码仍是 0）
  ensureVerifyProfile();
  const r = dumpConfig();
  if (!r.ok) bad.push('dump-config 失败（exit=' + r.status + '）');
  const notFound = [...r.err.matchAll(/\[([^\]]*cordis\.patch\.yml)\] patch: entry "([^"]+)" not found/g)].map((m) => m[2]);
  for (const id of new Set(notFound)) bad.push(id + '（patch 里写了、合成树里没有）');
  lines.push('  ' + (r.ok && !notFound.length ? '✓' : '✗') + ' 真 dump 核对 id 存在');

  console.log('verify（loader 同款求值器 + 负向自检）');
  console.log('表达式来源: ' + src);
  console.log((mode ? '模拟模式: ' : '当前模式: ') + simMode);
  console.log(lines.join('\n'));
  if (bad.length) { console.log('\n✗ 不一致:\n  - ' + bad.join('\n  - ')); process.exit(1); }
  const okCount = lines.filter((l) => l.includes('✓')).length;
  console.log('\n✓ ' + okCount + ' 项全绿（合成树里 ' + found.length + ' 条 !!js 表达式 + 3 个负向用例 + 1 次真 dump）');
}

function dumpConfig() {
  const r = spawnSync(DSH_EXE, ['--expose-internals', DSH_CLI, '--profile', '_verify', '--dump-config'], {
    env: { ...process.env, DSH_HOME, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 180000, windowsHide: true,
  });
  return { status: r.status, ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '') + (r.error ? '\n' + r.error.message : '') };
}

function ensureVerifyProfile() {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  for (const f of ['package.json', 'pnpm-workspace.yaml']) {
    const src = path.join(DESKTOP, f), dst = path.join(VERIFY_DIR, f);
    if (!fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) fs.copyFileSync(src, dst);
  }
  const pkgPath = path.join(VERIFY_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.name !== 'dsh-profile-verify') { pkg.name = 'dsh-profile-verify'; fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2)); }
  const nm = path.join(VERIFY_DIR, 'node_modules');
  if (!fs.existsSync(nm)) {
    try { fs.symlinkSync(path.join(DESKTOP, 'node_modules'), nm, 'junction'); }
    catch (e) { throw new Error('建 node_modules 联接失败: ' + e.message); }
  }
  fs.copyFileSync(PATCH, path.join(VERIFY_DIR, 'cordis.patch.yml'));
}

function usage() {
  console.log('用法: mode.cmd list | status | log | verify [模式] | <模式> [-n] [--verify] [--force]');
  console.log('\n模式:');
  for (const [k, v] of Object.entries(MODES)) console.log('  ' + k.padEnd(9) + v.desc + '   [ON: ' + (v.on.join(',') || '无') + ']');
  console.log('\n家族:');
  for (const [k, v] of Object.entries(FAMILIES)) console.log('  ' + k.padEnd(12) + v.label.padEnd(18) + '~' + v.tok + ' tok   ids=' + v.ids.join(','));
  console.log('\n状态文件: ' + STATE + '（patch 装配时读它，所以启动自动恢复）');
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('-n') || argv.includes('--dry-run');
const alsoVerify = argv.includes('--verify');
const force = argv.includes('--force');
const args = argv.filter((a) => !a.startsWith('-'));
const cmd = args[0];
const arg2 = args[1];
try {
  if (!cmd || cmd === 'list' || cmd === 'help' || cmd === '-h' || cmd === '--help') usage();
  else if (cmd === 'status') {
    const s = status();
    console.log('当前模式: ' + (s.fallback ? '(无 state.json，兜底全开)' : s.st.mode));
    console.log('开着的家族: ' + (s.on.join(', ') || '无'));
    console.log('关掉的家族: ' + (s.off.join(', ') || '无'));
    console.log('patch 开关段: ' + s.wired + ' 条 !!js 表达式' + (s.wired ? '' : '（还没接线，跑一次任意模式即可）'));
    if (s.st && s.st.ts) console.log('上次切换: ' + s.st.ts);
  } else if (cmd === 'log') {
    if (!fs.existsSync(LOG)) { console.log('还没有切换记录（' + LOG + '）'); }
    else {
      const rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
      console.log('切换记录（' + rows.length + ' 次）—— 时间 / 切到 / 从哪来 / 距上次');
      for (const row of rows.slice(-30)) {
        const [ts, to, from, gap] = row.split('\t');
        console.log('  ' + ts.slice(5, 19).replace('T', ' ') + '  → ' + to.padEnd(9) + 'from ' + (from || '-').padEnd(9) + gap);
      }
      console.log('\n每切一次，系统提示重写一次，账单 ≈ 当时的历史 token 数。');
    }
  } else if (cmd === 'verify') { writeBlockIfUnwired(); verify(arg2); }
  else { apply(cmd, dryRun, force); if (alsoVerify && !dryRun) verify(cmd); }
} catch (e) {
  console.error('[mode] ' + e.message);
  process.exit(1);
}
