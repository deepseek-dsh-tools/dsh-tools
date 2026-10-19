import { readFileSync, writeFileSync } from 'node:fs';
const P = 'D:/DSH/.dsh/profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js';
const src = readFileSync(P, 'utf8');
const START = src.indexOf('ClineAdapter = class extends LlmAdapter6');
if (START < 0) { console.log('FAIL: no ClineAdapter'); process.exit(1); }
const END = src.indexOf('// vendor/channel-pack/src/', START);
const seg = src.slice(START, END);

const MARK = '[patch 2026-10-18]';
if (seg.includes(MARK)) {
  console.log('SKIP: 补丁已存在，无需重复打（幂等）');
  process.exit(0);
}

const needle = [
  '  inputModalitiesFor(model) {',
  '    const entry = this.remoteModels?.find((candidate) => candidate.id === model);',
  '    return entry?.supportsImage === true ? ["text", "image"] : ["text"];',
  '  }'
].join('\n');
const count = seg.split(needle).length - 1;
console.log('ClineAdapter 段内命中次数:', count);
if (count !== 1) { console.log('ABORT: 未找到原始方法体（插件可能升级改写了这段）'); process.exit(1); }
const repl = [
  '  inputModalitiesFor(model) {',
  '    // [patch 2026-10-18] Cline 目录未标 image，但这些模型实为多模态',
  '    // （models.dev / openrouter / kilo 多网关均标 input:["text","image"]）。',
  '    // 不改这里 DSH 不会把图片送进来（prepareCall 直接抛错）。',
  '    if (model === "deepseek/deepseek-v4.1-flash-1017" || model === "deepseek/deepseek-v4.1-flash")',
  '      return ["text", "image"];',
  '    const entry = this.remoteModels?.find((candidate) => candidate.id === model);',
  '    return entry?.supportsImage === true ? ["text", "image"] : ["text"];',
  '  }'
].join('\n');
const next = src.slice(0, START) + seg.replace(needle, repl) + src.slice(END);
writeFileSync(P, next);
console.log('WROTE bytes:', next.length, '(old', src.length + ')');