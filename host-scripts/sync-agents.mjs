#!/usr/bin/env node
/**
 * sync-agents.mjs —— 保证 `D:\用户\AGENTS.md` 是指向 `D:\用户\念\AGENTS.md` 的符号链接
 *
 * 背景（2026-10-26）：AGENTS.md 真身已移入念库（GitHub 可版本化、工作区丢了能恢复），
 * 工作区留一个符号链接。但任何用 atomic rename 写文件的工具（编辑器原地保存、宿主插件、
 * 批量替换脚本）都会把链接替换成普通文件 —— 和技能那边同一个坑（见 AGENTS.md「Agent skills」）。
 *
 * 漂移后的处置规则（念库那份是唯一真相源）：
 *   1) 是链接且指向正确           → OK（退出 0）
 *   2) 是普通文件、内容与念库一致 → 删掉重建链接（退出 0）
 *   3) 是普通文件、内容不同       → 默认只报警（退出 2），不擅自覆盖任何一份
 *                                  加 --apply 时：把工作区那份备份到备份目录，再用念库那份重建链接
 *   4) 是链接但指向别处           → 报警（退出 3）
 *
 * 用法：
 *   node sync-agents.mjs                 预演（只报状态，不改）
 *   node sync-agents.mjs --apply         真的修（只修 2 和 3 两种情形）
 *   node sync-agents.mjs --root <dir> --soul <dir>   换路径（测试用）
 *
 * 退出码：0 正常/已修好 · 2 需要人看一眼（内容不同） · 3 链接指向别处 · 1 环境问题
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APPLY = flag('--apply');
const ROOT = path.resolve(opt('--root', 'D:/用户'));
const SOUL = path.resolve(opt('--soul', 'D:/用户/念'));
const LINK = path.join(ROOT, 'AGENTS.md');
const REAL = path.join(SOUL, 'AGENTS.md');
const BACKUP_DIR = path.resolve(opt('--backup', 'D:/用户/工具/备份/agents-drift'));

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const log = (s) => console.log(s);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function relaunchLink() {
  fs.rmSync(LINK, { force: true });
  fs.symlinkSync(REAL, LINK, 'file');
  const st = fs.lstatSync(LINK);
  if (!st.isSymbolicLink()) throw new Error('建完仍不是符号链接');
  if (fs.readFileSync(LINK).length !== fs.readFileSync(REAL).length) throw new Error('链接读到的长度与真身不一致');
}

function main() {
  if (!fs.existsSync(REAL)) {
    log(`✗ 念库真身不存在：${REAL}`);
    return 1;
  }
  if (!fs.existsSync(LINK)) {
    log(`* 工作区没有 AGENTS.md —— ${APPLY ? '建链接' : '预演：可建链接'}`);
    if (APPLY) { relaunchLink(); log(`✓ 已建符号链接 → ${REAL}`); }
    return 0;
  }

  const st = fs.lstatSync(LINK);
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(LINK);
    const resolved = path.resolve(path.dirname(LINK), target);
    if (resolved.toLowerCase() === REAL.toLowerCase()) {
      const a = sha(LINK), b = sha(REAL);
      if (a !== b) {
        log(`⚠ 链接路径正确但读到的内容与真身哈希不同（${a.slice(0, 12)} vs ${b.slice(0, 12)}）—— 检查是否有写入钩子`);
        return 2;
      }
      log(`✓ 正常：${LINK} → ${REAL}（${fs.statSync(REAL).size} B，内容一致）`);
      return 0;
    }
    log(`✗ 链接指向别处：${resolved}`);
    log(`  期望 → ${REAL}`);
    if (!APPLY) { log('  预演：加 --apply 会重建为正确指向'); return 3; }
    relaunchLink();
    log(`✓ 已重建 → ${REAL}`);
    return 0;
  }

  // 普通文件（原子写把链接替换掉了）
  const same = sha(LINK) === sha(REAL);
  if (same) {
    log(`* 工作区 AGENTS.md 是普通文件，但内容与念库一致（${fs.statSync(LINK).size} B）`);
    if (APPLY) { relaunchLink(); log(`✓ 已删除副本并重建链接 → ${REAL}`); }
    else log('  预演：加 --apply 会删除副本并重建链接');
    return 0;
  }

  log(`⚠ 内容不同：工作区 ${fs.statSync(LINK).size} B vs 念库 ${fs.statSync(REAL).size} B`);
  log(`  工作区 sha=${sha(LINK).slice(0, 12)}  念库 sha=${sha(REAL).slice(0, 12)}`);
  if (!APPLY) {
    log('  预演：不改。念库是真相源；加 --apply 会先把工作区那份备份，再用念库那份重建链接');
    return 2;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const bk = path.join(BACKUP_DIR, `AGENTS-workspace-${stamp()}.md`);
  fs.copyFileSync(LINK, bk);
  log(`  已备份工作区那份 → ${bk}`);
  relaunchLink();
  log(`✓ 已重建链接 → ${REAL}`);
  return 0;
}

let code = 1;
try {
  code = main();
} catch (e) {
  log(`✗ 异常：${e.message}`);
  code = 1;
}
process.exit(code);
