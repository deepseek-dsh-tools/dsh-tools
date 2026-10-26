#!/usr/bin/env node
/**
 * push-all-repos.mjs —— 把本地工程推到 deepseek-dsh-tools 名下（用户 2026-10-25 定的方针：
 * 「以后做好插件上传 GitHub，这里的东西更加安全」）。
 *
 * 背景（为什么必须靠这个脚本）：这台机器**没有 gh CLI、没有 GITHUB_TOKEN**，HTTPS 走 GCM
 * 非 tty 拿不到 token，只能 SSH 推**已存在**的仓库 ⇒ 新建仓库必须人在网页上做
 * （https://github.com/new，保持空仓库、不要勾 README/gitignore/license）。
 * 所以流程是：用户建空仓库 → 跑本脚本 → 全部推上去。
 *
 * 用法：
 *   node push-all-repos.mjs             # 只探测（哪些仓库已存在、哪些还缺、各目录待推几个提交）
 *   node push-all-repos.mjs --push      # 真推（只推「仓库已存在」的）
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const GIT = "D:/ComfyUI-aki-v3.2/git/cmd/git.exe";
const ORG = "deepseek-dsh-tools";
const SSH_KEY = "D:/用户/.gh-keys/gh_key";
const KNOWN_HOSTS = "D:/用户/.gh-keys/known_hosts";
const doPush = process.argv.includes("--push");

/** 工程 → 远端仓库名（默认同名）。加新工程就往这里加一行。 */
const PROJECTS = [
	{ name: "dsh-guardian", dir: "D:/用户/代码/dsh-guardian" },
	{ name: "dsh-tools", dir: "D:/用户/代码/dsh-tools" },
	{ name: "soul", dir: "D:/用户/代码/soul" },
	{ name: "agent-bus", dir: "D:/用户/代码/agent-bus" },
	{ name: "dsh-comfyforge", dir: "D:/用户/代码/dsh-comfyforge" },
	{ name: "dsh-soul-link", dir: "D:/用户/工具/dsh-plugins/dsh-soul-link" },
	{ name: "dsh-web-search-brave", dir: "D:/用户/工具/dsh-plugins/dsh-web-search-brave" },
	{ name: "novel-preset", dir: "D:/用户/工具/dsh-plugins/novel-preset" },
	// 念库（记忆本体）：仓库复用 private 的 `soul`，推到独立分支 nian，
	// 免得和引擎代码（main 分支）混在一起（2026-10-26 定）。
	{ name: "soul-memory", dir: "D:/用户/念", remote: "soul", refspec: "HEAD:nian" }
];

const env = {
	...process.env,
	HOME: "D:/用户",
	GIT_SSH_COMMAND: `ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS}`,
	GIT_AUTHOR_NAME: ORG,
	GIT_AUTHOR_EMAIL: `${ORG}@users.noreply.github.com`,
	GIT_COMMITTER_NAME: ORG,
	GIT_COMMITTER_EMAIL: `${ORG}@users.noreply.github.com`
};

function git(dir, args) {
	return spawnSync(GIT, ["-C", dir, ...args], { encoding: "utf8", env, windowsHide: true });
}

/** 同步阻塞睡眠（重试间隔用；标准库没有 sync sleep，Atomics.wait 是唯一不引依赖的写法）。 */
function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let missing = [];
let pushed = 0;
let failed = 0;

for (const project of PROJECTS) {
	if (!existsSync(join(project.dir, ".git"))) {
		console.log(`✗ ${project.name.padEnd(22)} 不是 git 仓库（先 git init）`);
		failed++;
		continue;
	}

	// 远端存在性探测：**必须区分「真不存在」与「网络抖动」** ——
	// 2026-10-25 17:20 计划任务首次运行就撞上了：GitHub 网页/SSH 抖了一下，
	// `ls-remote` 非 0 退出被当成「仓库不存在」，脚本以 exit 2 收场，实际 8 个全在。
	// 所以这里对网络类报错重试 3 次（间隔递增），只有明确 404/repo-not-found 才算真缺。
	const remoteName = project.remote ?? project.name;
	const url = `git@github.com:${ORG}/${remoteName}.git`;
	let exists = false;
	for (let attempt = 0; attempt < 3; attempt++) {
		const probe = spawnSync(GIT, ["ls-remote", url], { encoding: "utf8", env, windowsHide: true, timeout: 60000 });
		if (probe.status === 0) {
			exists = true;
			break;
		}
		const err = `${probe.stderr || ""}${probe.stdout || ""}`;
		if (/Repository not found|does not exist|not found/i.test(err)) break; // 真缺，不必重试
		if (attempt < 2) sleepMs(3000 * (attempt + 1));
	}

	if (!exists) {
		console.log(`✗ ${project.name.padEnd(22)} 远端仓库不存在 → 去 https://github.com/new 建空仓库 ${ORG}/${remoteName}`);
		missing.push(project.name);
		continue;
	}

	// remote 没配就补上（先看现状，别覆盖已有的）
	const remotes = git(project.dir, ["remote"]).stdout.trim();
	if (!remotes.split(/\r?\n/).includes("origin")) {
		git(project.dir, ["remote", "add", "origin", url]);
	}

	const dirty = git(project.dir, ["status", "--porcelain"]).stdout.trim();
	const ahead = git(project.dir, ["rev-list", "--count", "@{u}..HEAD"]).stdout.trim();

	if (!doPush) {
		console.log(`· ${project.name.padEnd(22)} 仓库在，未提交 ${dirty ? dirty.split(/\r?\n/).length : 0} 个文件，领先 ${ahead || "?"} 个提交`);
		continue;
	}

	// 有改动先落一次提交，再推（推送不该因为「忘了提交」而什么都不做）
	if (dirty) {
		git(project.dir, ["add", "-A"]);
		const commit = git(project.dir, ["commit", "-m", `同步：${new Date().toISOString().slice(0, 10)}`]);
		if (commit.status !== 0) {
			console.log(`✗ ${project.name.padEnd(22)} 提交失败：${(commit.stderr || commit.stdout).trim().slice(0, 200)}`);
			failed++;
			continue;
		}
	}

	const push = git(project.dir, ["push", "-u", "origin", project.refspec ?? "HEAD:main"]);
	if (push.status === 0) {
		console.log(`✓ ${project.name.padEnd(22)} 已推送`);
		pushed++;
	} else {
		console.log(`✗ ${project.name.padEnd(22)} 推送失败：${(push.stderr || push.stdout).trim().slice(0, 300)}`);
		failed++;
	}
}

console.log("");
if (doPush) {
	console.log(`推送完成：成功 ${pushed} · 失败 ${failed} · 缺仓库 ${missing.length}`);
} else {
	console.log(`探测完成：缺仓库 ${missing.length}（${missing.join(", ") || "无"}）`);
	console.log("加 --push 真推。");
}
if (missing.length > 0) {
	console.log("");
	console.log("缺的仓库（网页建，保持空仓库）：");
	for (const name of missing) console.log(`  https://github.com/new  仓库名 ${name}`);
	process.exitCode = 2;
}
