#!/usr/bin/env node
/**
 * 修 raccoon 渠道「模型不支持图片输入」。
 *
 * 症状：DSH 里附图片发送报 `raccoon: 模型 "sn-deepseek-v4-1-flash-1017" 不支持图片输入`
 *       （LlmError / UNSUPPORTED_CONTENT），或图片被投影成占位符。
 *
 * 根因：dsh-our-free-model 的 vendor/channel-pack/pack.js 里
 *   RACCOON_IMAGE_CAPABILITY_OVERRIDES 只列了裸 id（`sn-deepseek-v4-1-flash`、
 *   `sn-glm-5-3-flash`），而远端模型目录给的 id 带日期后缀（`...-1017`），
 *   且远端 tags 不含 vision ⇒ raccoonSupportsImage() 判 false ⇒
 *   RaccoonAdapter.inputModalitiesFor() 只报 ['text'] ⇒ 图片发不出去。
 *
 * 修法：比对前先剥掉尾部 `-<数字>` 再查白名单。
 *
 * 用法：node fix-raccoon-vision.mjs [--check]
 *   无参 = 打补丁（幂等，已打过则跳过）
 *   --check = 只检查状态
 *
 * 注意：插件是 npm 装的，升级 dsh-our-free-model 会覆盖 pack.js，升级后重跑本脚本。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOME = (process.env.DSH_HOME || 'D:/DSH_Home/.DSH').replace(/\\/g, '/');
const PACK = `${HOME}/profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js`;
const MARK = '[patch 2026-10-21] 远端目录给的 id 带日期后缀';

const ORIGINAL = `function raccoonSupportsImage(modelId, tags) {
  if (RACCOON_IMAGE_CAPABILITY_OVERRIDES.has(modelId)) return true;
  return tags.includes("vision") || tags.includes("image") || tags.includes("image-understanding");
}`;

const PATCHED = `function raccoonSupportsImage(modelId, tags) {
  if (RACCOON_IMAGE_CAPABILITY_OVERRIDES.has(modelId)) return true;
  // ${MARK}（如 \`sn-deepseek-v4-1-flash-1017\`），
  // 而 OVERRIDES 里只有裸 id ⇒ 同一模型换个账号/换个快照就掉出白名单、被判成纯文本，
  // DSH 侧直接抛 UNSUPPORTED_CONTENT（「模型不支持图片输入」）。改为剥离尾部
  // \`-<数字>\` 后再比一次，幂等且不影响原有命中。
  if (RACCOON_IMAGE_CAPABILITY_OVERRIDES.has(String(modelId).replace(/-\\d+$/, ""))) return true;
  return tags.includes("vision") || tags.includes("image") || tags.includes("image-understanding");
}`;

const checkOnly = process.argv.includes('--check');

if (!existsSync(PACK)) {
  console.log(`[skip] 找不到 pack.js：${PACK}（插件未安装？）`);
  process.exit(1);
}

const text = readFileSync(PACK, 'utf8');

if (text.includes(MARK)) {
  console.log('[ok] 补丁已在位，无需重复打。');
  process.exit(0);
}
if (!text.includes(ORIGINAL)) {
  console.log('[warn] 找不到原始函数体 —— 插件版本可能变了，手动核对 raccoonSupportsImage()。');
  process.exit(2);
}
if (checkOnly) {
  console.log('[miss] 补丁未打。');
  process.exit(3);
}

const bak = `${PACK}.bak-before-vision-fix`;
if (!existsSync(bak)) copyFileSync(PACK, bak);
writeFileSync(PACK, text.replace(ORIGINAL, PATCHED), 'utf8');

const after = readFileSync(PACK, 'utf8');
if (!after.includes(MARK)) {
  console.log('[fail] 写入后校验未通过。');
  process.exit(4);
}
console.log('[done] 已打补丁。重启 DSH 生效。备份：' + bak);
