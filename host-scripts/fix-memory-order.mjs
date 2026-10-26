#!/usr/bin/env node
/**
 * fix-memory-order.mjs —— 让 dsh-memory-core 的记忆注入顺序「追加式稳定」
 *
 * 为什么：`dsh-memory-core/lib/index.js` 的 `renderBlock()` 用 `list()` 取事实，而
 * `list()` 的 SQL 是 `ORDER BY pinned DESC, updated_at DESC`。于是每 `memory_remember`
 * 一次，那条就跳到列表顶部、其余整体下移 → system prompt 里
 * `## Persistent Memory` 整段字节全变 → 上游前缀缓存从该段起全部作废
 * （真机实测：每次作废 ~9035 字符，放大成一次全量重付 ≈ 40K~90K token）。
 *
 * 改成「pinned 置顶 + 其余按 created_at 升序」后，新条目**追加到末尾**，
 * 老行位置永不动 → 同一场景作废从 9035 字符降到 **29 字符**。
 *
 * 幂等：已打过补丁直接跳过。dsh-memory-bundle 升级会覆盖 node_modules，
 * 升级后重跑本脚本即可（`node fix-memory-order.mjs` / `--check` 只检测）。
 *
 * 验证：`D:\用户\工具\verify-mem-order.mjs`（等价渲染 + 真库数据 + 前缀比对）
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HOME = (process.env.DSH_HOME || 'D:/DSH_Home/.DSH').replace(/\\/g, '/');
const TARGET = `${HOME}/profiles/desktop/node_modules/dsh-memory-bundle/plugins/dsh-memory-core/lib/index.js`;
const MARK = 'TokenForge/缓存修复（2026-10-22）';

const OLD = `		const facts = this.list(workspace, this.config.maxFacts);
		let block;
		if (facts.length === 0) {
			block = "";
		} else {
			const hasUserRows = facts.some((fact) => isUserAuthored(fact));
			const lines = facts.map((fact) => \`- \${isUserAuthored(fact) ? "[pinned] " : ""}[\${fact.topic}] \${fact.content}\`);
			block = \`## Persistent Memory (workspace: \${workspace || "(root)"})\${hasUserRows ? "\\nEntries marked [pinned] were written by the user and cannot be changed by any tool." : ""}\\n\${lines.join("\\n")}\`;
		}`;

const NEW = `		const facts = this.list(workspace, this.config.maxFacts);
		// ★ ${MARK}：\`list()\` 按 updated_at DESC 取，最近写入的排最前。
		//   于是一条新记忆进来，整段 Persistent Memory 的所有行都位移 → system prompt 从本段
		//   开始字节全变 → 上游前缀缓存整段作废（实测每次 ~31.7K 字符，放大成全量重付）。
		//   改成「pinned 置顶 + 其余按 created_at 升序」：新条目**追加到末尾**，老行位置永不动，
		//   前缀稳定，只有尾部增长。取数仍是最新的 maxFacts 条（溢出时最老一条掉出，偶发）。
		const pinnedFacts = facts.filter((fact) => fact.pinned);
		const timelineFacts = facts.filter((fact) => !fact.pinned)
			.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
		const ordered = [...pinnedFacts, ...timelineFacts];
		let block;
		if (ordered.length === 0) {
			block = "";
		} else {
			const hasUserRows = ordered.some((fact) => isUserAuthored(fact));
			const lines = ordered.map((fact) => \`- \${isUserAuthored(fact) ? "[pinned] " : ""}[\${fact.topic}] \${fact.content}\`);
			block = \`## Persistent Memory (workspace: \${workspace || "(root)"})\${hasUserRows ? "\\nEntries marked [pinned] were written by the user and cannot be changed by any tool." : ""}\\n\${lines.join("\\n")}\`;
		}`;

const checkOnly = process.argv.includes('--check');

if (!existsSync(TARGET)) {
  console.error(`✗ 目标不存在：${TARGET}`);
  process.exit(1);
}

const src = readFileSync(TARGET, 'utf8');
if (src.includes(MARK)) {
  console.log(`✓ 已打过补丁（${MARK}），无需处理`);
  process.exit(0);
}
if (!src.includes(OLD)) {
  console.error('✗ 找不到待替换的原始片段 —— 插件版本可能已变（升级/重构）。');
  console.error('  请先 `node --check` 并人工比对 renderBlock()，不要盲目套用。');
  process.exit(2);
}
if (checkOnly) {
  console.log('· 尚未打补丁（原文片段可匹配，可以安全应用）');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const bak = `${TARGET}.bak-before-memorder-${stamp}`;
copyFileSync(TARGET, bak);
writeFileSync(TARGET, src.replace(OLD, NEW), 'utf8');

try {
  execFileSync(process.execPath, ['--check', TARGET], { stdio: 'inherit' });
} catch {
  copyFileSync(bak, TARGET);
  console.error('✗ 语法检查失败，已回滚');
  process.exit(3);
}

console.log(`✓ 补丁已应用（备份：${bak}）`);
console.log('  重启 DSH 后生效；验证：node "D:/用户/工具/verify-mem-order.mjs"');
console.log('  ⚠ 插件升级会覆盖 node_modules，升级后重跑本脚本。');
