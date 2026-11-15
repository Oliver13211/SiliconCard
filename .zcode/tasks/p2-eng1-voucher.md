# P2-ENG1 先手平衡 · 电费抵扣券 · 任务书（WF-ENGINE 全流程）

任务执行者身份：先读 `.zcode/agents/engine-dev.md`，以其身份约束自己。验收标准：`docs/phase2-plan.md` §P2-ENG1。工作目录：仓库根。

## 机制定稿（用户已拍板，不得更改量纲）

- **后手玩家（P2）在 initGame 起手阶段额外获得一张「电费抵扣券」**：一次性卡，打出后**本回合供电 +300W（可超 1000W 上限）**；回合结束未使用则失效消失；不占 30 张卡组名额（起手照旧 3 张 + 券）。
- 券为**引擎内建特殊卡**，不进 content 可收集池：core 内注册其 CardDefinition（id 建议 `siliconcard-voucher`，name 电费抵扣券，faction 建议 neutral，type 按 schema 现状定夺；注意 `findCardDefinitionIssues` 的 cost∈[100,1000] 校验需为此卡放行或豁免，方式自定并汇报）；客户端卡面走 cardArt 既有渲染（按 def 自动出图），如渲染需要 art 字段特殊值请写明。

## 实现要点

1. constants 新增 `VOUCHER_BONUS = 300`；
2. 供电超上限语义：券效果使本回合 availableMana 可越 MAX_MANA（其余路径仍不得越），回合结束清零语义与 overload 锁定的交互按 rules.md 既有条款推演并写清；
3. **事件目录**：新增 `COIN_GRANTED` 或并入 CARD_DRAWN 加 source 标记——你评估后定稿（倾向：新增事件更清晰，目录 +1）；
4. **旧回放兼容（重要）**：优先保证既有对局动作 uid 语义不受影响——券的发放安排在常规发牌之后追加、uid 使用独立命名空间/独立游标，使**旧录制回放仍可逐动作重放**；若引擎 uid 生成机制做不到完全隔离，如实说明影响面（哪些旧回放会漂移）与理由；
5. **黄金回放基线全部重录**（initGame 行为变化），版本注记写明；fuzz/testing 同步；
6. **AI（packages/ai）**：学会用券——基本启发式即可（如：手牌里有打不出的高费卡时用券），不做深度搜索；
7. 下游同步：client/server/cli 三端检查 initGame 调用点与 view 渲染（client 手牌 UI 显示券、server AI 席起手、cli 起手打印），预期多数自动生效，逐一验证并汇报；
8. **rules.md 升版（WF-ENGINE 文档义务）**：§2 回合流程（券发放与超上限）、§6 事件目录（新增事件）、§9（如涉疲劳交互）、§13 版本号 bump + 变更注记。

## 验收标准（量化，QA2 管线复测由主控安排，你先自证引擎侧）

1. 单测：P2 起手 3+1（券）；P1 无券；券打出后本回合供电 +300 可超 1000W；回合结束未用消失；券不可被抽牌复制/不进牌库；确定性（同 seed 两次 initGame 状态一致）；
2. 事件流：券发放事件恰一次、打出批次事件正确；
3. **旧回放回归**：用 git 历史里一期黄金基线的动作序列在新引擎上重放——若你实现了 uid 隔离则必须全部仍可重放且终局一致；不可行则给出漂移清单；
4. 黄金基线重录后全绿；fuzz 绿；全 core 测试绿；
5. typecheck/lint 全仓干净（本次改动跨包，你可跑全仓——此任务无并行代理文件冲突，EDU1 代理只动 ui/tutorial 与 content/decks，你**禁碰**这两处与 ui/ 其余、three/**）。

## 边界

packages/core/**（含测试与基线）、packages/ai/**、packages/server/**、packages/cli/**、packages/client 仅限 net/protocol.ts 与 view/hand 类型相关必要同步（**禁碰** ui/**、three/**）、docs/rules.md、content **禁碰**（券不入 content）。EDU1 代理在并行写 ui/tutorial/** 与 content/decks/tutorial-*.json，勿交叉。

## 验证与汇报

全仓 yarn typecheck / lint / test / build 四门禁（排除 ui/tutorial 相关失败——那是并行代理在途文件，失败要甄别归属）；禁 git commit/push。
汇报四字段：files / summary（事件定稿、超上限实现、uid 隔离方案与旧回放结论、AI 启发式、rules.md 变更点）/ checks（四门禁关键输出 + 旧基线重放结论）/ deviations（如实）。
