#!/usr/bin/env node
// 记忆管理 · 手动查看/修改跨会话记忆
//   双击同目录的 记忆.cmd      -> 交互菜单（推荐）
//   node memory-tool.mjs list|show|add|edit|del|pin|unpin|files|open|menu
// 数据源 1：D:/DSH/.dsh/memory-core.db 的 core_facts 表 —— 每轮对话自动注入的事实
// 数据源 2：D:/用户/记忆/ 下两份档案 —— AI 主动读的长期档案
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const show = (p) => p.split("/").join(BS);
const DSH_HOME = "D:/DSH/.dsh";
const DB_PATH = DSH_HOME + "/memory-core.db";
const BACKUP_DIR = DSH_HOME + "/cache/memory-db-backup";
const WORKSPACE = "D:" + BS + "用户";
const FILES = [
  ["关于你.md", "D:/用户/记忆/关于你.md"],
  ["我们的进展.md", "D:/用户/记忆/我们的进展.md"],
];

const sha = (s) => createHash("sha256").update(s).digest("hex");
const isNum = (s) => /^[0-9]+$/.test(String(s));

function open(write = false) {
  if (!fs.existsSync(DB_PATH)) throw new Error("找不到记忆库：" + show(DB_PATH));
  const db = new DatabaseSync(DB_PATH, write ? {} : { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
function backup(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const f = BACKUP_DIR + "/memory-core-" + new Date().toISOString().replace(/[:.]/g, "-") + ".db";
  db.exec("VACUUM INTO '" + f + "'");
  return show(f);
}
function fmt(ts) { try { return new Date(Number(ts)).toLocaleString("zh-CN", { hour12: false }); } catch { return String(ts); } }
function rows(db, all = false) {
  const sql = "SELECT * FROM core_facts" + (all ? "" : " WHERE workspace = ?") + " ORDER BY updated_at DESC";
  return all ? db.prepare(sql).all() : db.prepare(sql).all(WORKSPACE);
}
function pick(db, sel, all = false) {
  if (!sel) throw new Error("要指定条目：编号，或内容里的关键词。");
  const list = rows(db, all);
  if (isNum(sel)) {
    const i = Number(sel);
    if (i < 1 || i > list.length) throw new Error("编号超出范围（1-" + list.length + "）。");
    return list[i - 1];
  }
  const hit = list.filter((r) => r.content.includes(sel) || r.fact_id.startsWith(sel) || r.topic === sel);
  if (hit.length === 1) return hit[0];
  if (hit.length === 0) throw new Error("没有匹配「" + sel + "」的条目。");
  throw new Error("匹配到 " + hit.length + " 条，请用编号指定：" + hit.map((r) => list.indexOf(r) + 1).join(", "));
}

// ---------- 操作 ----------
function opList(db, all = false, full = false) {
  const list = rows(db, all);
  console.log("");
  console.log((all ? "全部事实" : "工作区 " + show(WORKSPACE) + " 的事实") + "：" + list.length + " 条");
  list.forEach((r, i) => {
    console.log("");
    console.log(" " + (i + 1) + ") [" + r.topic + "] " + fmt(r.updated_at) + " · " + (r.pinned ? "已固定" : "未固定") + " · " + r.source + " · " + r.fact_id.slice(0, 8));
    const body = full || r.content.length <= 200 ? r.content : r.content.slice(0, 200) + "…";
    console.log("    " + body.split(NL).join(NL + "    "));
  });
  console.log("");
}
function opShow(db, sel, all = false) {
  const r = pick(db, sel, all);
  console.log("");
  console.log("fact_id   : " + r.fact_id);
  console.log("workspace : " + show(r.workspace));
  console.log("topic     : " + r.topic + "    source: " + r.source + "    confidence: " + r.confidence + "    " + (r.pinned ? "已固定" : "未固定"));
  console.log("created   : " + fmt(r.created_at) + "    updated: " + fmt(r.updated_at));
  console.log("-------------------------------------------");
  console.log(r.content);
  console.log("");
}
function opAdd(content, topic = "general", pin = false) {
  if (!content || content.trim().length < 4) throw new Error("内容太短，没加。");
  const db = open(true);
  const dup = db.prepare("SELECT fact_id FROM core_facts WHERE content_hash = ? OR content = ?").all(sha(content), content);
  if (dup.length) { console.log(""); console.log("已有内容相同的条目（" + dup[0].fact_id.slice(0, 8) + "），没有重复添加；要改它请用「改写」。"); return; }
  const b = backup(db), now = Date.now(), id = randomUUID();
  db.prepare("INSERT INTO core_facts (fact_id,workspace,topic,content,content_hash,confidence,pinned,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, WORKSPACE, topic, content, sha(content), 0.9, pin ? 1 : 0, "user", now, now);
  console.log("");
  console.log("已加入 " + id.slice(0, 8) + "（分类 " + topic + (pin ? "，已固定" : "") + "）");
  console.log("备份：" + b);
  console.log("下一轮对话起自动注入。");
}
function opEdit(sel, content, all = false) {
  if (!content || !content.trim()) throw new Error("要给出新内容。");
  const db = open(true), r = pick(db, sel, all), b = backup(db);
  db.prepare("UPDATE core_facts SET content = ?, content_hash = ?, confidence = 0.9, source = 'user', updated_at = ? WHERE fact_id = ?")
    .run(content, sha(content), Date.now(), r.fact_id);
  console.log("");
  console.log("已改写 " + r.fact_id.slice(0, 8) + "（备份：" + b + "）");
}
function opDel(sel, all = false) {
  const db = open(true), r = pick(db, sel, all), b = backup(db);
  db.prepare("DELETE FROM core_facts WHERE fact_id = ?").run(r.fact_id);
  console.log("");
  console.log("已删除 [" + r.topic + "] " + r.content.slice(0, 60) + "…（备份：" + b + "）");
}
function opPin(sel, v, all = false) {
  const db = open(true), r = pick(db, sel, all);
  backup(db);
  db.prepare("UPDATE core_facts SET pinned = ? WHERE fact_id = ?").run(v ? 1 : 0, r.fact_id);
  console.log("");
  console.log((v ? "已固定 " : "已取消固定 ") + r.fact_id.slice(0, 8));
}
function opFiles() {
  console.log("");
  for (const [n, p] of FILES) {
    let st = "缺失";
    try { const s = fs.statSync(p); st = s.size + " 字节 · 改于 " + fmt(s.mtimeMs); } catch {}
    console.log("  档案   " + n + "    " + show(p));
    console.log("         (" + st + ")");
  }
  console.log("  事实库 " + show(DB_PATH));
  console.log("  索引库 " + show(DSH_HOME + "/memory-index.db") + "（会话检索用，自动维护）");
  console.log("  备份   " + show(BACKUP_DIR));
  console.log("");
}
function opOpen(i) {
  const targets = i ? [FILES[i - 1]].filter(Boolean) : FILES;
  for (const [, p] of targets) spawn("notepad.exe", [p], { detached: true, stdio: "ignore" }).unref();
  console.log("");
  console.log("已用记事本打开 " + targets.length + " 个文件 —— 保存时选 UTF-8。");
}
function help() {
  console.log("");
  console.log("记忆管理 —— 手动查看 / 修改跨会话记忆（不加参数就是交互菜单）");
  console.log("");
  console.log("  记忆 list [--all]                             列出事实");
  console.log("  记忆 show <编号>                               看某条全文");
  console.log("  记忆 add 「内容」 [--topic=convention] [--pin]   新增一条");
  console.log("  记忆 edit <编号> 「新内容」                     改写");
  console.log("  记忆 del <编号> [--yes]                        删除");
  console.log("  记忆 pin|unpin <编号>                          固定 / 取消固定");
  console.log("  记忆 files / open [1|2]                        文件位置 / 打开档案");
  console.log("");
  console.log("  条目可以用编号，也可以用内容里的关键词（唯一匹配才行）。");
  console.log("  写操作前会自动备份数据库到 " + show(BACKUP_DIR));
  console.log("");
}

// ---------- 交互菜单 ----------
async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => { closed = true; });
  const ask = (q) => {
    if (closed) return Promise.resolve("");
    return new Promise((res) => {
      const onClose = () => res("");
      rl.once("close", onClose);
      rl.question(q, (a) => { rl.removeListener("close", onClose); res(String(a)); });
    });
  };
  console.log("");
  console.log("==============================================");
  console.log("   记忆管理       工作区 " + show(WORKSPACE));
  console.log("   这里的事实会每轮对话自动注入给 AI");
  console.log("==============================================");
  for (;;) {
    if (closed) { console.log(""); break; }
    let count = "?";
    try { count = rows(open(), false).length; } catch (e) { console.log(" 读不到记忆库：" + e.message); }
    console.log("");
    console.log(" 当前 " + count + " 条事实");
    console.log("  [1] 列出全部（含全文）    [2] 看某条全文      [3] 新增一条");
    console.log("  [4] 改写某条              [5] 删除某条        [6] 固定 / 取消固定");
    console.log("  [7] 打开档案（记事本）    [8] 文件在哪        [q] 退出");
    let c = "";
    try { c = String(await ask(" 选择> ")).trim().toLowerCase(); } catch { break; }
    if (c === "q" || c === "quit" || c === "exit") { console.log(""); console.log(" 再见。"); break; }
    try {
      if (c === "1") { opList(open(), false, true); }
      else if (c === "2") { opList(open(), false, false); const s = String(await ask(" 看第几条（编号或关键词）> ")).trim(); if (s) opShow(open(), s, false); else console.log(" 取消。"); }
      else if (c === "3") {
        const t = String(await ask(" 要记住的内容> ")).trim();
        if (!t) { console.log(" 没输入，取消。"); }
        else {
          const tp = String(await ask(" 分类（直接回车=general）> ")).trim() || "general";
          const p = String(await ask(" 固定它吗？(y/N) > ")).trim();
          opAdd(t, tp, /^y/i.test(p));
        }
      }
      else if (c === "4") {
        opList(open(), false, false);
        const s = String(await ask(" 改写第几条> ")).trim();
        if (!s) { console.log(" 取消。"); }
        else { const t = String(await ask(" 新内容> ")).trim(); if (t) opEdit(s, t, false); else console.log(" 没输入，取消。"); }
      }
      else if (c === "5") {
        opList(open(), false, false);
        const s = String(await ask(" 删除第几条> ")).trim();
        if (!s) { console.log(" 取消。"); }
        else {
          const r = pick(open(), s, false);
          const y = String(await ask(" 确认删除 [" + r.topic + "] " + r.content.slice(0, 50) + "… ？(y/N) > ")).trim();
          if (/^y/i.test(y)) opDel(s, false); else console.log(" 取消。");
        }
      }
      else if (c === "6") {
        opList(open(), false, false);
        const s = String(await ask(" 固定 / 取消固定 第几条> ")).trim();
        if (!s) { console.log(" 取消。"); }
        else { const r = pick(open(), s, false); opPin(s, !r.pinned, false); }
      }
      else if (c === "7") { opOpen(0); }
      else if (c === "8") { opFiles(); }
      else if (c === "") { }
      else { console.log(" 没有这个选项。"); }
    } catch (e) { console.log(""); console.log(" 出错了：" + (e && e.message ? e.message : String(e))); }
    await ask(" 按回车回到菜单…");
  }
  rl.close();
}

// ---------- 命令行 ----------
async function cli(argv) {
  const cmd = (argv[0] || "").toLowerCase();
  const args = argv.slice(1);
  const flag = (n) => args.includes("--" + n);
  const opt = (n, d) => { const a = argv.find((x) => x.startsWith("--" + n + "=")); return a ? a.slice(n.length + 3) : d; };
  const pos = args.filter((a) => !a.startsWith("--"));
  const all = flag("all");
  switch (cmd) {
    case "list": case "ls": case "列表": opList(open(), all, true); break;
    case "show": case "cat": case "看": opShow(open(), pos[0], all); break;
    case "add": case "新增": opAdd(pos[0], opt("topic", "general"), flag("pin")); break;
    case "edit": case "改": opEdit(pos[0], pos[1], all); break;
    case "del": case "rm": case "删除": {
      const r = pick(open(), pos[0], all);
      if (!flag("yes")) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const q = "确定删除这条？" + NL + "  [" + r.topic + "] " + r.content.slice(0, 80) + NL + "  (y/N) ";
        const ans = await new Promise((res) => rl.question(q, res));
        rl.close();
        if (!/^y(es)?$/i.test(String(ans).trim())) { console.log("已取消。"); break; }
      }
      opDel(pos[0], all); break;
    }
    case "pin": opPin(pos[0], true, all); break;
    case "unpin": opPin(pos[0], false, all); break;
    case "files": case "档案": opFiles(); break;
    case "open": case "打开": opOpen(pos[0] && isNum(pos[0]) ? Number(pos[0]) : 0); break;
    default: help(); break;
  }
}

const argv = process.argv.slice(2);
if (!argv.length || argv[0].toLowerCase() === "menu") {
  await menu();
} else {
  try { await cli(argv); } catch (e) { console.error("出错：" + (e && e.message ? e.message : String(e))); process.exit(1); }
}
