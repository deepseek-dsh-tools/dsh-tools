# DSH 补丁集（DSH 升级 / 插件更新后需重打）

## 1. patch-pack-cline.mjs —— 让 cline 通道的 deepseek 模型声明图片输入

**为什么**：Our Free Model 的 `ClineAdapter.inputModalitiesFor()` 只认远端目录里的
`supportsImage`。Cline 的模型目录（`/api/v1/ai/cline/recommended-models`）压根没列
`deepseek/deepseek-v4.1-flash-1017`，models.dev 的 `cline-pass` 块也没有它 →
`inputModalitiesFor` 一律返回 `["text"]` → DSH 的 `assertImageCapableRoute` 拒绝读图，
而且 `prepareCall` 里有硬闸，图根本不会进请求体。

但该模型在 models.dev 的 `openrouter` / `kilo` / `nano-gpt` / `engy` 等多个 provider
下都是 `input: ["text","image"]`（attachment=true），确实是多模态。

**改什么**：`vendor/channel-pack/pack.js` 里 `ClineAdapter` 段的 `inputModalitiesFor`，
给 `deepseek/deepseek-v4.1-flash-1017` 与 `deepseek/deepseek-v4.1-flash` 直接返回
`["text","image"]`。备份在同目录 `backups/20261018-225215/pack.js`。

**目标文件**（随插件版本变，脚本里已写死）：
`D:/DSH_Home/.DSH/profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js`

**怎么跑**：
```bash
export NODE=/d/DSH/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe
"$NODE" D:/DSH_Home/.DSH/cache/safe-change/patch-pack-cline.mjs
"$NODE" /d/DSH/.dsh/cache/safe-change/safe-change.mjs check "/d/DSH/.dsh/profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js"
"$NODE" /d/DSH/.dsh/cache/safe-change/safe-change.mjs import "/d/DSH/.dsh/profiles/desktop/node_modules/dsh-our-free-model/index.js"
```
脚本是幂等的：找到 `inputModalitiesFor` 后先检查是否已有补丁标记；已打过就直接退出。

**注意**：补丁写在 `vendor/channel-pack/pack.js` 里，**dsh-our-free-model 一升级就会被覆盖**
（2026-10-18 上游 2.5.3 的 `src/catalog.js:59` 仍是 `{match:/^deepseek/, vision:false}`）。
插件更新后 read_image 又报 `does not declare image input` 就重跑本脚本。

**生效条件**：改完必须重启 DSH（宿主进程里跑的是旧字节码）。
