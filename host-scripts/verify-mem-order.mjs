/**
 * 验证 memory-core 记忆渲染顺序改动：插入一条新记忆后，system 里这段的公共前缀还剩多少。
 * 等价复刻 lib/index.js renderBlock 的渲染（纯 map），不写库、不联网。
 */
import { DatabaseSync } from 'node:sqlite';

const WS = process.argv[2] ?? 'D:\\用户';
const db = new DatabaseSync('D:/DSH/.dsh/memory-core.db', { readOnly: true });
const rows = db.prepare(
  'SELECT fact_id, topic, content, pinned, source, created_at, updated_at FROM core_facts WHERE workspace = ?',
).all(WS);

const isUser = (f) => f.pinned === 1 || f.source === 'human';
const render = (list) => `## Persistent Memory (workspace: ${WS})\n`
  + list.map((f) => `- ${isUser(f) ? '[pinned] ' : ''}[${f.topic}] ${f.content}`).join('\n');

// 改前：SQL 的 ORDER BY pinned DESC, updated_at DESC（取回时已按此序，这里复刻一下）
const oldWay = (l) => [...l].sort((a, b) => (b.pinned - a.pinned) || (b.updated_at - a.updated_at));
// 改后：pinned 置顶 + 其余按 created_at 升序（新条目追加末尾）
const newWay = (l) => {
  const p = l.filter((x) => x.pinned);
  const r = l.filter((x) => !x.pinned).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return [...p, ...r];
};

const now = Date.now();
const mk = (i) => ({
  fact_id: `__probe${i}__`, topic: 'lesson', content: `【验证用】第 ${i} 条刚写入的新记忆`, pinned: 0, source: 'model',
  created_at: now + i, updated_at: now + i,
});

const lcp = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i += 1; return i; };

console.log(`记忆条数: ${rows.length}  created_at 为空的: ${rows.filter((r) => r.created_at == null).length}`);
for (const [name, scheme] of [['改前 updated_at DESC', oldWay], ['改后 created_at ASC', newWay]]) {
  let prev = render(scheme(rows));
  const stop = [];
  for (let i = 1; i <= 3; i += 1) {
    const next = render(scheme([...rows, mk(1), ...(i >= 2 ? [mk(2)] : []), ...(i >= 3 ? [mk(3)] : [])]));
    stop.push(`${next.length - lcp(prev, next)}`);
    prev = next;
  }
  const before = render(scheme(rows));
  const after = render(scheme([...rows, mk(1)]));
  console.log(`\n[${name}]`);
  console.log(`  段长 ${before.length} → ${after.length}`);
  console.log(`  插 1 条：保留前缀 ${lcp(before, after)} (${(lcp(before, after) / before.length * 100).toFixed(1)}%) ⇒ 作废 ${after.length - lcp(before, after)} 字符`);
  console.log(`  连续插 3 条，每次作废字符: ${stop.join(' / ')}`);
  console.log(`  末行: ${after.split('\n').at(-1).slice(0, 44)}`);
}

// 不变量：改后渲染的行集合必须与改前完全一致（只允许顺序不同，不允许多/少一条）
{
  const a = render(oldWay(rows)).split('\n').slice(1).sort();
  const b = render(newWay(rows)).split('\n').slice(1).sort();
  const same = a.length === b.length && a.every((line, i) => line === b[i]);
  console.log(`\n[不变量] 改后行集合与改前一致：${same ? '✓ 是' : '✗ 否'}（${a.length} vs ${b.length} 行）`);
  if (!same) {
    const onlyA = a.filter((x) => !b.includes(x));
    const onlyB = b.filter((x) => !a.includes(x));
    console.log('  仅有改前:', onlyA.length, ' 仅有改后:', onlyB.length);
    process.exitCode = 1;
  }
}

// pinned 变动的代价（改后方案：pinned 置顶 ⇒ 变 pin 会位移到顶部）
const pinOne = rows.map((r, i) => (i === Math.floor(rows.length / 2) ? { ...r, pinned: 1 } : r));
{
  const before = render(newWay(rows));
  const after = render(newWay(pinOne));
  console.log(`\n[改后 · 某条被 pin] 作废 ${after.length - lcp(before, after)} 字符（一次性，极少发生）`);
}
// 同 fact_id 内容被顶替（v13 那个坑）
{
  const target = rows[10];
  const edited = rows.map((r) => (r.fact_id === target.fact_id ? { ...r, content: `${r.content}（已修订）` } : r));
  const before = render(newWay(rows));
  const after = render(newWay(edited));
  console.log(`[改后 · 第 11 条内容被顶替] 作废 ${after.length - lcp(before, after)} 字符（一行宽）`);
}
