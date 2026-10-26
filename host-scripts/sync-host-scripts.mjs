#!/usr/bin/env node
/**
 * sync-host-scripts.mjs —— `D:\用户\工具\` 根脚本 → 本目录（镜像）
 *
 * 方向是单向的：`D:\用户\工具\` 是源（真身，计划任务与配置写死了那条路径），这里是副本。
 *
 * 用法：
 *   node sync-host-scripts.mjs            # 预演，只报差异
 *   node sync-host-scripts.mjs --apply    # 真同步
 *
 * 退出码：0 = 全一致或已同步 / 2 = 有差异（预演模式）/ 3 = 源文件缺失
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SRC = "D:/用户/工具";
const DST = "D:/用户/代码/dsh-tools/host-scripts";
const APPLY = process.argv.includes("--apply");

const FILES = [
	"daily-backup.mjs",
	"dsh-auth-cookie-doctor.cmd",
	"dsh-auth-cookie-doctor.py",
	"dsh-auth-cookie-guard.ps1",
	"dsh-auth-cookie-guard.vbs",
	"dsh-bili-clean.ps1",
	"dsh-bili-clean.vbs",
	"fix-encoding.py",
	"fix-memory-order.mjs",
	"fix-raccoon-context.mjs",
	"fix-raccoon-vision.mjs",
	"push-all-repos.mjs",
	"sync-agents.mjs",
	"sync-skills.mjs",
	"verify-mem-order.mjs"
];

const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);

const same = [];
const changed = [];
const created = [];
const missing = [];

for (const f of FILES) {
	const src = join(SRC, f);
	const dst = join(DST, f);
	if (!existsSync(src)) {
		missing.push(f);
		continue;
	}
	if (!existsSync(dst)) {
		created.push(f);
	} else if (digest(src) === digest(dst)) {
		same.push(f);
		continue;
	} else {
		changed.push(f);
	}
	if (APPLY) writeFileSync(dst, readFileSync(src));
}

console.log(`${APPLY ? "同步" : "预演"}：源 ${SRC}  →  镜像 ${DST}`);
console.log(`  一致 ${same.length} · 新增 ${created.length} · 有更新 ${changed.length} · 源缺失 ${missing.length}`);
if (created.length) console.log(`  新增：${created.map((f) => `\n    + ${f}`).join("")}`);
if (changed.length) console.log(`  有更新：${changed.map((f) => `\n    ~ ${f}`).join("")}`);
if (missing.length) console.log(`  源缺失（真身不在，需人工确认）：${missing.map((f) => `\n    ? ${f}`).join("")}`);
if (missing.length) process.exit(3);
if (!APPLY && (created.length || changed.length)) process.exit(2);
console.log(APPLY ? "镜像已更新，记得在 dsh-tools 里提交。" : "（预演模式未写盘；加 --apply 真同步）");
process.exit(0);
