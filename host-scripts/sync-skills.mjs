#!/usr/bin/env node
/**
 * sync-skills.mjs —— 让「念」成为技能的**唯一真相源**，DSH 侧只留符号链接。
 *
 * 布局：
 *   D:\用户\念\技能\<name>\SKILL.md       ← 真相源（念引擎认这个格式）
 *   D:\DSH_Home\.DSH\skills\<name>.md     ← 符号链接，指向上面那份
 *
 * 为什么必须「链接」而不是「复制」：两边的格式天生不同，且都不由我们说了算 ——
 *   · DSH 技能加载器（dsh-memory-bundle/plugins/dsh-memory-skills/lib/index.js:302）
 *     用 `join(skillDir, `${name}.md`)` 定位、`:308` 用 `.endsWith(".md")` 过滤 ⇒ **只认扁平文件**；
 *   · 念引擎（soul/store.py 的 `list_skills`）遍历 `技能/<name>/SKILL.md` ⇒ **只认目录结构**。
 *   链接是唯一能同时满足两边、又不产生第二份正文的办法。
 *
 * 为什么是「符号链接」而不是「硬链接」（2026-10-25 实测）：硬链接绑 inode，任一侧做
 *   atomic rename（写临时文件再改名；PowerShell 的 Set-Content 也这样）就换 inode ⇒ 当场断裂，
 *   而且断得无声无息（实测 `Set-Content hard.txt` 后 src.txt='v1'、hard.txt='v3'）。
 *   符号链接绑路径，不会断。
 *
 * 冲突裁决：两侧都存在且**都不是链接**时，按 mtime 新者为准写回真相源
 *   （DSH 侧更新通常意味着刚用 skill 工具改过技能 ⇒ 该搬进念；念侧更新是真相源自己的改动）。
 *   DSH 侧的 atomic 写会把符号链接替换成普通文件，这种漂移也靠同一套逻辑自动收敛。
 *
 * 用法：
 *   node sync-skills.mjs            # 预演，只报告
 *   node sync-skills.mjs --apply    # 落地
 *   node sync-skills.mjs --apply --prune   # 额外删掉 DSH 侧「念里已没有」的孤儿 .md
 */
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DSH_SKILLS = resolve(process.env.DSH_SKILLS ?? "D:/DSH_Home/.DSH/skills");
const SOUL_SKILLS = resolve(process.env.SOUL_SKILLS ?? "D:/用户/念/技能");
const LOG_FILE = resolve(process.env.SYNC_SKILLS_LOG ?? "D:/用户/工具/Temp/sync-skills.log");
const apply = process.argv.includes("--apply");
const prune = process.argv.includes("--prune");

const lines = [];
const log = (message) => {
	const line = `${apply ? "[apply]" : "[dry-run]"} ${message}`;
	lines.push(line);
	console.log(line);
};
const problems = [];

function ensureDir(path) {
	mkdirSync(path, { recursive: true });
}

/** Point a symlink at `target`, replacing whatever is there now. */
function relink(linkPath, target) {
	if (existsSync(linkPath) || isLink(linkPath)) rmSync(linkPath, { force: true });
	symlinkSync(target, linkPath, "file");
}

function isLink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function mtimeOf(path) {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

function sameContent(a, b) {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

ensureDir(SOUL_SKILLS);
if (!existsSync(DSH_SKILLS)) {
	console.error(`DSH 技能目录不存在：${DSH_SKILLS}`);
	process.exit(2);
}

// ---- 1) DSH 侧 → 念（真相源）------------------------------------------------
let imported = 0;
let relinked = 0;
let kept = 0;
/** 真相源里最终会有哪些技能。预演时也要算上「本轮将导入」的，否则第 3 步会把它们误报成孤儿。 */
const soulNames = new Set();

for (const entry of readdirSync(DSH_SKILLS)) {
	if (!entry.endsWith(".md")) continue;
	const name = entry.slice(0, -3);
	const dshPath = join(DSH_SKILLS, entry);
	const soulDir = join(SOUL_SKILLS, name);
	const soulPath = join(soulDir, "SKILL.md");
	const link = isLink(dshPath);
	const target = link ? readlinkSync(dshPath) : null;
	const pointsHere = link && resolve(dirname(dshPath), target) === resolve(soulPath);

	if (pointsHere && existsSync(soulPath)) {
		kept++;
		continue;
	}

	if (link && !existsSync(soulPath)) {
		problems.push(`符号链接指向的目标不存在：${dshPath} → ${target}（念里没这个技能）`);
	}

	ensureDir(soulDir);
	soulNames.add(name);
	if (!existsSync(soulPath)) {
		log(`导入真相源：${name} ← ${dshPath}`);
		if (apply) copyFileSync(dshPath, soulPath);
		imported++;
	} else if (link) {
		// 链接指向别处 / 目标刚建好 —— 直接重建
		log(`重建链接：${entry} → 念/${name}/SKILL.md`);
		if (apply) relink(dshPath, soulPath);
		relinked++;
	} else {
		const dshNewer = mtimeOf(dshPath) > mtimeOf(soulPath);
		if (sameContent(dshPath, soulPath)) {
			log(`内容相同，只补链接：${entry}`);
			if (apply) {
				rmSync(dshPath, { force: true });
				relink(dshPath, soulPath);
			}
			relinked++;
		} else if (dshNewer) {
			log(`DSH 侧较新，写回真相源：${name}（${mtimeOf(dshPath)} > ${mtimeOf(soulPath)}）`);
			if (apply) {
				copyFileSync(dshPath, soulPath);
				rmSync(dshPath, { force: true });
				relink(dshPath, soulPath);
			}
			imported++;
		} else {
			log(`念侧较新，覆盖 DSH 侧：${name}`);
			if (apply) {
				rmSync(dshPath, { force: true });
				relink(dshPath, soulPath);
			}
			relinked++;
		}
	}
}

// ---- 2) 念侧 → DSH（新技能要挂上）------------------------------------------
let added = 0;
for (const dir of readdirSync(SOUL_SKILLS)) {
	if (dir.startsWith("_") || dir.startsWith(".")) continue; // 念引擎也跳过 `_` 前缀（内部目录）
	const soulPath = join(SOUL_SKILLS, dir, "SKILL.md");
	if (!existsSync(soulPath)) continue;
	soulNames.add(dir);
	const dshPath = join(DSH_SKILLS, `${dir}.md`);
	if (existsSync(dshPath) || isLink(dshPath)) continue;
	log(`挂到 DSH：${dir}.md → 念/${dir}/SKILL.md`);
	if (apply) relink(dshPath, soulPath);
	added++;
}

// ---- 3) 孤儿（可选 prune）---------------------------------------------------
let orphans = 0;
for (const entry of readdirSync(DSH_SKILLS)) {
	if (!entry.endsWith(".md")) continue;
	const name = entry.slice(0, -3);
	if (soulNames.has(name)) continue;
	orphans++;
	if (prune) {
		log(`删除孤儿：${entry}（念里没有 ${name}）`);
		if (apply) rmSync(join(DSH_SKILLS, entry), { force: true });
	} else {
		log(`孤儿（未删，加 --prune 才动）：${entry}`);
	}
}

console.log("");
const summary = `${apply ? "已应用" : "预演"}：导入/写回 ${imported} · 补链接 ${relinked} · 新挂 ${added} · 已一致 ${kept} · 孤儿 ${orphans}`;
console.log(summary);
if (problems.length > 0) {
	console.log("");
	for (const problem of problems) console.log(`  ⚠ ${problem}`);
}
if (!apply) console.log("\n（这是预演，什么都没改；加 --apply 落地）");

// 计划任务每小时跑一次 --apply，靠这行日志留痕（只记摘要与有变动的行，不是整场 dump）。
try {
	if (apply) {
		const changes = lines.filter((line) => !line.includes("内容相同，只补链接") || relinked === 0);
		appendFileSync(LOG_FILE, `\n[${new Date().toISOString()}] ${summary}\n${changes.join("\n")}\n`, "utf8");
	}
} catch {
	/* 日志写不进去不该让同步失败 */
}
