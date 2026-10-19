---
name: "dsh-prompt-inject-edit"
description: "dsh-purge 的 prompt-inject.md 怎么改、无损压缩天花板是多少、改完怎么验证、改哪层是有损的。"
whenToUse: "要改 DSH 的 preamble / 注入提示词 / 给 preamble 瘦身时"
metadata:
  managed: true
  source: "model"
---

# preamble（dsh-purge 注入稿）编辑

## 文件与机制
- 源：`D:\DSH\.dsh\prompt-inject.md`（出厂默认加密在 `lib/asset-table.js`，运行时以磁盘文件为准，`lib/core.js:2397`）
- 注入：`hang full prompt-inject at head`（`lib/core.js:5591`）；patch #87 `HUNG_PROMPT_LF_NEEDLE` 取文件**末尾 96 字符**做指纹去重，纯 LF 才不误判
- 生效：**每轮读盘、每步比对 → 下一轮起生效，不用重启**。代价是掉一次 prompt cache。

## 无损天花板：≈9%（不是 5%，也不是 5000 字符）
2026-10-18 实测：25128 → 22952 B（226 → 175 行），**≈9%**。更早一轮只做到 3.6%（省 754 字符）。

**做法**：只动结构层 —— `═══` 分隔线换 `##` 标题、重复段合并、banned 词表用脚本从原文两段抽并集去重。

**一字不改的**：Scoped Rules 25 条（4,985 字符）、canned slots（2,992）、banned 列表（1,671）—— 每行都是能力，动它们＝有损（C 层，需用户批准）。

## 验证
`D:\DSH\.dsh\cache\safe-change\verify-inject.mjs`（中文短语无丢失、占位符只差段标题、工具名全在、canned slots 全在、Scoped Rules 全在）。破坏变体可证真咬。

## 做完的检查
`safe-change check` SKIP（非 JS/YAML）+ `headless` PASS*（仅缺 API key）；`purge_status` 应见 82 patch 全 applied + `[#87] HUNG_PROMPT_LF_NEEDLE applied`。
