# @siliconcard/content — 卡牌数据包

卡牌与派系的唯一数据来源，**只放 JSON 与文档，不放逻辑**。

- `cards/` — 卡牌定义，schema 见 [docs/design-report.md](../../docs/design-report.md) §2.6
- `factions/` — 派系与英雄技能定义

新增卡牌的标准流程：[docs/agents/workflows.md](../../docs/agents/workflows.md) → WF-CARD（JSON + 效果注册 + 单测 三件套）。
数值禁止硬编码进引擎代码；效果只能引用 core 已注册的效果原语。
