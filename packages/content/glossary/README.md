# glossary/ — 效果白话翻译器数据包（P2-UI2-1）

把 `EffectSpec`（12 效果原语 × TargetSelector × AuraSpec × 触发时点）翻译成圈内人话的**纯声明式规则表**。
本目录只放 JSON 与文档，禁止任何逻辑；渲染（拼装、占位符替换）由客户端（P2-UI2-2 / P2-UI4 图鉴）按同一语义实现，
契约语义的参考实现见 `packages/core/src/content-tests/glossary.test.ts` 的 `matchStep`。

## 文件

- `effects-glossary.json` — 翻译规则表本体。

## Schema（version 1）

顶层七键：

| 键 | 形态 | 作用 |
| --- | --- | --- |
| `version` | number | 规则表版本，schema 变更时递增 |
| `triggers` | `Record<EffectTrigger, string>` | 触发时点前缀短语（8 个，键集 ≡ `cards.ts` 的 `EffectTrigger`） |
| `selectors` | `Record<string, string>` | 目标短语，键为 `"<kind>|<pool>"` 或 `"<kind>|<pool>|<tag>"` |
| `ops` | `Record<op, { template, params? }>` | 每个效果原语一条模板（12 键，键集 ≡ `EffectStep` 的 op 集合） |
| `keywords` | `Record<Keyword, string>` | 七关键词各一条带梗解释 |
| `handlers` | `Record<string, string>` | 命名 handler 解释（须与引擎 `effects/handlers.ts` 注册表对齐） |
| `special` | `Record<string, string>` | 组合特例短语，匹配优先级 **special > ops** |

### 占位符

模板与 special 短语中允许 `{placeholder}`，全集：`target / amount / count / attack / health /
keyword / player / pick / to / cardId / delta / handler`。替换来源：

- `{target}` ← `selectors` 短语；`{keyword}` ← `keywords` 词条；`{handler}` ← `handlers` 词条；
- `{amount} {count} {attack} {health}` ← 步骤数值；`{delta}` ← 光环数值（可负）；
- `{player} {pick} {to}` ← 对应 op 条目的 `params` 子表；
- `{cardId}` ← 客户端卡牌注册表解析为卡名（glossary 不存卡名，避免双份事实源）；
- revive 步骤未写 `count` 时渲染端按 1 处理（special 短语中的 `{count}` 恒渲染实际张数）。

## 匹配优先级（渲染器与 matchStep 同语义）

对每个步骤，按顺序尝试：

1. **special 整步覆盖**（命中即用，不再走 ops）：
   - 光环步骤：`"aura|<stat>|<scope>"`；
   - revive 步骤：`"revive|<pick>"`；
   - 带 player 的步骤（draw / gainArmor / lockMana）：`"<op>|<player>"`；
   - 带 target 的步骤：`"<op>|<kind>|<pool>|<tag>"`，再退 `"<op>|<kind>|<pool>"`。
2. **ops 通用模板**：
   - handler 步骤直接查 `handlers[step.name]`（`ops.handler` 仅为键集完备的占位兜底）；
   - 其余 op 取 `ops[op].template`，`{target}` 按 `selectors["kind|pool|tag"]` → `selectors["kind|pool"]`
     兜底解析（tag 条目缺失时渲染端应自行补注「限标签：<tag>」）；数值与 params 子表照上表替换。

## 维护纪律

- 新增效果原语 / 触发时点 / 关键词（跨包契约，走 WF-ENGINE）时，glossary 必须同步补条目——
  `content-tests/glossary.test.ts` 的全卡池扫描会响亮报错兜底；
- 新增标签（tags）无需登记：走 `kind|pool` 兜底；为常用标签补精确短语是加分项（参考 `all|enemyUnits|miner`）；
- 解释文案先准确后好玩：所有括号内的机制细节（质保不挡拆除、复活重置、场满截断等）均对齐 `docs/rules.md` §5–§7，
  改文案不许改掉这些事实。
