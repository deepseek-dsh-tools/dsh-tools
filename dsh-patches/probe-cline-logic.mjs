import { readFileSync } from 'node:fs';
const P = 'D:/DSH_Home/.DSH/profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js';
const src = readFileSync(P, 'utf8');
const START = src.indexOf('ClineAdapter = class extends LlmAdapter6');
const seg = src.slice(START, src.indexOf('// vendor/channel-pack/src/', START));
// 抽出 inputModalitiesFor 方法源码
const m = seg.match(/  inputModalitiesFor\(model\) \{[\s\S]*?\n  \}/);
if (!m) { console.log('FAIL: 抽不到方法'); process.exit(1); }
const body = m[0];
console.log('=== 方法源码 ===');
console.log(body);
// 构造一个最小 stub 并求值
const fnSrc = 'return (function ' + body.replace(/^  /gm, '') + ')';
const fn = new Function('model', body.replace(/^  /gm, ''));
const fakeThis = { remoteModels: [{ id: 'xxx/other', supportsImage: false }] };
const test = (m2) => fn.call(fakeThis, m2);
console.log('\n=== 行为测试 ===');
for (const mm of ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash', 'xxx/other', 'unknown/model']) {
  console.log(mm, '->', JSON.stringify(test(mm)));
}
