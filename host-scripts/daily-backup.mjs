#!/usr/bin/env node
/**
 * daily-backup.mjs —— 每天一次的三层兜底（用户 2026-10-25：「GitHub 是主防线」之外的自留地）。
 *
 * 1) **会话进念库**：把 DSH 的会话转录折成 Markdown 放进 `D:\用户\念\会话\`。
 *    这是 10-24 事故后唯一能保住对话正文的办法 —— 那次 sessions 正文全军覆没，
 *    235 个会话 md 是之前手动导入的，属于运气。
 * 2) **念库自检**：`reindex`（A2：索引可重建）+ `export`（记忆导出成 md）。
 * 3) **插件源码快照**：`D:\用户\工具\dsh-plugins` 只有几百 KB（排除 node_modules），
 *    整份复制最省事，不依赖 git 是否配好。
 * 4) **git bundle**：有 .git 的工程各打一个 bundle（单个文件，含全部历史），
 *    比复制工作树小得多，且能 `git clone <bundle>` 直接还原。
 *
 * 保留策略：快照留最近 7 份，更早的自动删。
 *
 * 用法：
 *   node daily-backup.mjs            # 真跑
 *   node daily-backup.mjs --dry-run  # 只报告要做什么
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const PYTHON = "D:/用户/工具/pythons/cpython-3.12.15-windows-x86_64-none/python.exe";
const SOUL_CODE = "D:/用户/代码/soul";
const SOUL_ROOT = "D:/用户/念";
const DSH_HOME = "D:/DSH_Home/.DSH";
const PLUGIN_DIR = "D:/用户/工具/dsh-plugins";
const BACKUP_ROOT = "D:/用户/工具/备份";
const GIT = "D:/ComfyUI-aki-v3.2/git/cmd/git.exe";
const KEEP = 7;

/** 要打 bundle 的工程（有 .git 的才打）。2026-10-26 补：dsh-context-forge / yt-auto 刚 git init（此前零备份），念库本体也不在列表里过。 */
const GIT_REPOS = [
	"D:/用户/代码/dsh-guardian",
	"D:/用户/代码/dsh-tools",
	"D:/用户/代码/soul",
	"D:/用户/代码/agent-bus",
	"D:/用户/代码/dsh-comfyforge",
	"D:/用户/代码/dsh-context-forge",
	"D:/用户/代码/yt-auto",
	"D:/用户/念",
	"D:/用户/工具/dsh-plugins/dsh-soul-link",
	"D:/用户/工具/dsh-plugins/dsh-web-search-brave",
	"D:/用户/工具/dsh-plugins/novel-preset"
];

const dryRun = process.argv.includes("--dry-run");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const report = [];

function line(message) {
	report.push(message);
	console.log(message);
}

function run(command, args, options = {}) {
	if (dryRun) return { status: 0, stdout: "(dry-run)", stderr: "" };
	return spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
}

// ---------- 1) 会话导入念库 ----------
line(`[1/4] 会话导入念库（${DSH_HOME} → ${SOUL_ROOT}/会话）`);
if (!existsSync(DSH_HOME)) {
	line("  跳过：DSH_HOME 不存在");
} else {
	const imported = run(PYTHON, ["-m", "soul", "--root", SOUL_ROOT, "sessions-import", "--home", DSH_HOME], {
		cwd: SOUL_CODE,
		env: { ...process.env, PYTHONIOENCODING: "utf-8" }
	});
	const out = (imported.stdout || "").trim().split(/\r?\n/).filter(Boolean);
	// soul CLI 的 exit 2 = "有条目没导进去"（多数是空会话：读到但 messages 为空，
	// sessions.py:555 就计 failed）。这不是故障，只有 ≥3 才算真出错。
	line(`  ${out[0] || "(无输出)"}  exit=${imported.status}${imported.status === 2 ? "（2 = 有跳过/空会话，正常）" : ""}`);
	if (imported.status !== 0 && imported.status !== 2) line(`  ! ${(imported.stderr || "").trim().slice(0, 300)}`);
}

// ---------- 2) 念库 reindex + export ----------
line(`[2/4] 念库 reindex + export`);
const reindex = run(PYTHON, ["-m", "soul", "--root", SOUL_ROOT, "reindex"], {
	cwd: SOUL_CODE,
	env: { ...process.env, PYTHONIOENCODING: "utf-8" }
});
line(`  reindex exit=${reindex.status} ${(reindex.stdout || "").trim().split(/\r?\n/).slice(-1)[0] || ""}`);
const exported = run(PYTHON, ["-m", "soul", "--root", SOUL_ROOT, "export"], {
	cwd: SOUL_CODE,
	env: { ...process.env, PYTHONIOENCODING: "utf-8" }
});
line(`  export  exit=${exported.status} ${(exported.stdout || "").trim().split(/\r?\n/).slice(-1)[0] || ""}`);

// ---------- 3) 插件源码快照 ----------
const pluginSnapshot = join(BACKUP_ROOT, stamp, "dsh-plugins");
line(`[3/4] 插件源码快照 → ${pluginSnapshot}`);
if (dryRun) {
	line("  (dry-run) 跳过复制");
} else if (!existsSync(PLUGIN_DIR)) {
	line("  跳过：插件目录不存在");
} else {
	mkdirSync(pluginSnapshot, { recursive: true });
	cpSync(PLUGIN_DIR, pluginSnapshot, {
		recursive: true,
		filter: (source) => !/[\\/](node_modules|\.venv|__pycache__|dist)([\\/]|$)/.test(source)
	});
	const count = readdirSync(pluginSnapshot).length;
	line(`  已复制 ${count} 个顶层条目`);
}

// ---------- 4) git bundle ----------
const bundleDir = join(BACKUP_ROOT, stamp, "git-bundles");
line(`[4/4] git bundle → ${bundleDir}`);
if (dryRun) {
	line("  (dry-run) 跳过打包");
} else {
	mkdirSync(bundleDir, { recursive: true });
	let ok = 0;
	let skipped = 0;
	for (const repo of GIT_REPOS) {
		const name = repo.split("/").pop();
		if (!existsSync(join(repo, ".git"))) {
			line(`  · ${name}：无 .git，跳过`);
			skipped++;
			continue;
		}
		const bundle = join(bundleDir, `${name}.bundle`);
		const result = spawnSync(GIT, ["-C", repo, "bundle", "create", bundle, "--all"], { encoding: "utf8", windowsHide: true });
		if (result.status === 0) {
			const size = Math.round(statSync(bundle).size / 1024);
			line(`  ✓ ${name}：${size} KB`);
			ok++;
		} else {
			line(`  ✗ ${name}：${(result.stderr || result.stdout || "").trim().slice(0, 200)}`);
		}
	}
	line(`  成功 ${ok} · 跳过 ${skipped}`);

	// 保留最近 KEEP 份（按目录名 YYYYMMDD 排序）
	if (existsSync(BACKUP_ROOT)) {
		const days = readdirSync(BACKUP_ROOT, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^\d{8}$/.test(entry.name))
			.map((entry) => entry.name)
			.sort();
		for (const old of days.slice(0, Math.max(0, days.length - KEEP))) {
			rmSync(join(BACKUP_ROOT, old), { recursive: true, force: true });
			line(`  清理旧快照 ${old}`);
		}
	}
}

console.log("");
console.log(`完成（${dryRun ? "dry-run" : stamp}）。备份根：${BACKUP_ROOT}`);
