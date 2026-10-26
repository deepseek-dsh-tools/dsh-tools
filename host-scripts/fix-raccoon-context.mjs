#!/usr/bin/env node
/**
 * fix-raccoon-context.mjs — 让 raccoon 的 fallback 模型表对「带日期后缀的远端 id」也生效。
 *
 * 问题（2026-10-25 实测取证）：
 *   dsh-our-free-model/vendor/channel-pack/pack.js 里 RaccoonAdapter.resolveModel() 是
 *     const entry    = all.find((item) => item.id === model);        // 远端目录
 *     const fallback = this.fallbackIndex.get(model);                // 兜底表，key 是裸 id
 *     const contextWindow = entry?.contextWindow ?? fallback?.contextWindow;
 *     if (contextWindow !== void 0 && contextWindow > 0) resolved.context = { contextWindow };
 *   而 RACCOON_FALLBACK_MODELS 里的条目 id 是 `sn-deepseek-v4-1-flash`（裸 id），
 *   实际调用时模型 id 是 `sn-deepseek-v4-1-flash-1017`（远端带日期后缀）
 *   ⇒ fallbackIndex.get() 永不命中 ⇒ 远端不下发 contextWindow 时 resolved.context 缺失
 *   ⇒ 宿主 compaction-basic 认为该 route「无容量」，压缩链根本不工作。
 *
 * 这与 RACCOON_IMAGE_CAPABILITY_OVERRIDES 是同一类 bug（facts 里记过），修法同款：
 *   完整 id 未命中时，剥掉尾部 `-<数字>` 再查一次。幂等、可重复执行。
 *
 * 注意：`const fallback = this.fallbackIndex.get(model);` 在同一文件里出现 3 次
 * （raccoon / loomy / 其它 adapter 的 resolveModel 写法相同）。
 * 因此本脚本**只改 RaccoonAdapter 类内部的第一处**，不做全局替换。
 *
 * 用法：
 *   node fix-raccoon-context.mjs            # 干跑，只报告会改什么
 *   node fix-raccoon-context.mjs --apply    # 真改（先自动备份 .bak-before-context-fix）
 *
 * 插件升级会覆盖 pack.js —— 升级后重跑本脚本。退出码：0 成功/无需改；2 找不到锚点；3 冲突。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs';

const TARGETS = [
  'D:/DSH_Home/.DSH/profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js',
];

const MARK = '[patch 2026-10-25]';
const CLASS_ANCHOR = 'var RaccoonAdapter = class extends LlmAdapter8';
const OLD = '    const fallback = this.fallbackIndex.get(model);';
const NEW = [
  `    // ${MARK} 远端 id 带日期后缀（如 sn-deepseek-v4-1-flash-1017），而兜底表 key 是裸 id`,
  '    // （sn-deepseek-v4-1-flash）⇒ 完整 id 查不到时剥掉尾部 -<数字> 再查一次。',
  '    // 不删原查询：原命中优先级不变，只在未命中时兜底。幂等，可重复执行。',
  "    const fallback = this.fallbackIndex.get(model) ?? this.fallbackIndex.get(String(model).replace(/-\\d+$/, ''));",
].join('\n');

const apply = process.argv.includes('--apply');
let rc = 0;

for (const path of TARGETS) {
  if (!existsSync(path)) {
    console.log(`[skip] 不存在: ${path}`);
    continue;
  }
  const src = readFileSync(path, 'utf8');
  const size = statSync(path).size;

  const classAt = src.indexOf(CLASS_ANCHOR);
  if (classAt < 0) {
    console.log(`[FAIL] 找不到 RaccoonAdapter 类锚点: ${path}`);
    rc = 2;
    continue;
  }

  const regionEnd = Math.min(src.length, classAt + 20000);
  const at = src.indexOf(OLD, classAt);
  if (at < 0 || at > regionEnd) {
    if (src.slice(classAt, regionEnd).includes(MARK)) {
      console.log(`[ok  ] 已打过补丁，跳过: ${path} (${size} B)`);
      continue;
    }
    console.log(`[FAIL] RaccoonAdapter 内找不到 fallback 锚点: ${path}`);
    rc = 2;
    continue;
  }
  if (src.slice(classAt, at).includes(MARK)) {
    console.log(`[ok  ] 已打过补丁，跳过: ${path} (${size} B)`);
    continue;
  }

  console.log(`[plan] ${path} (${size} B)`);
  console.log(`   类定义 @${classAt}，补丁点 @${at}`);
  console.log('   - ' + OLD.trim());
  console.log('   + ' + NEW.split('\n').pop().trim());

  if (!apply) {
    console.log('   (干跑；加 --apply 才写)');
    continue;
  }

  const bak = path + '.bak-before-context-fix';
  copyFileSync(path, bak);
  const out = src.slice(0, at) + NEW + src.slice(at + OLD.length);
  writeFileSync(path, out, 'utf8');

  // 写后三重校验：标记在、只改一处、长度差符合预期
  const after = readFileSync(path, 'utf8');
  const delta = after.length - src.length;
  const ok = after.includes(MARK)
    && (after.split("this.fallbackIndex.get(model) ?? this.fallbackIndex.get").length - 1) === 1
    && Math.abs(delta - (NEW.length - OLD.length)) < 1;
  if (!ok) {
    console.log(`   [FAIL] 写后校验不通过（delta=${delta}），恢复备份`);
    copyFileSync(bak, path);
    rc = 3;
    continue;
  }
  console.log(`   [done] 已写入并校验通过（+${delta} B）；备份: ${bak}`);
}

console.log(rc === 0 ? 'RESULT: OK' : `RESULT: FAILED (rc=${rc})`);
process.exit(rc);
