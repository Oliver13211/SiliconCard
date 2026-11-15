# P2-EDU1 体系化教程（五关） · 任务书

任务执行者身份：先读 `.zcode/agents/client-ui.md`（教程控制器）并兼任 card-content 职责（教学卡组与文案——用户拍板**零教学专用卡**，全部从现有 90 卡池组装，故无 content JSON 新卡，只组教学预组卡组）。验收标准：`docs/phase2-plan.md` §P2-EDU1。工作目录：仓库根。

## 五关设计（plan 定稿）

| 关 | 名称 | 教学内容 | 过关目标（事件流判定） |
| --- | --- | --- | --- |
| 1 | 通电 | 供电/回合/结束回合概念 | 一个回合内打出 3 张卡 |
| 2 | 上机 | 出牌/攻击/信仰充值（英雄技能） | 摧毁敌方一台显卡 |
| 3 | 关键词七连 | 七关键词逐节讲解 | 每节「必用该关键词」过关（用三年质保挡一刀 / 用无输出亮机卡骗一刀 / 双芯打两刀 / 等等） |
| 4 | 派系对决 | 自选派系打一整局 | 对局中善用 3 次派系技能 |
| 5 | 自由实战 | 进真对局 | 进真实 SetupScreen（前 3 回合提示气泡可做成 Setup 时的说明或首关回放式引导，形态自定） |

## 技术方案（引擎零改动，铁律）

1. **教程 = 受约束的对局**：每关固定 seed + 教学预组卡组（`packages/content/decks/tutorial-*.json`，普通预组格式，卡组构成你设计——七关键词素材现成：taunt=Mac Pro 2013、divine_shield=AppleCare+、charge=天玑 9300、windfury=M1 Ultra、deathrattle=Helio G99、stealth=MacBook Air M2、overload=Exynos 8895；第 1/2 关用便宜卡组）+ **脚本对手**（引擎确定性保证可精确编排——对手动作序列写死或按回合触发的轻规则，禁用 AI 随机性）；
2. **教程控制器**（`ui/tutorial/**` 新目录）：拦截 UI——动作白名单过滤（基于 getLegalActions 收窄）、目标高亮、气泡文案（讲什么、下一步点什么）、错误重试提示；过关判定消费真实事件流（如检测 divine_shield 的 shieldConsumed、单位死亡、技能使用次数）；
3. **进度**：localStorage 持久化（跳关解锁——任意关卡直达，重玩不破坏进度）；
4. **入口与挂载**：主菜单「新手教程」按钮 + AppRoot 路由由主控接线——你导出 TutorialScreen（内含关卡选择）与 controller，汇报写清挂载约定（route 名/组件 props）；
5. **文案**：教学气泡口吻与全站一致（圈内自嘲、梗味，但教学内容准确无歧义）；每关末尾小结。

## 边界（并行期严格隔离）

独占：`ui/tutorial/**`、`styles/tutorial.css`（新，组件 import）、`packages/content/decks/tutorial-*.json`。**禁碰**：core/**（券代理在改引擎，你全部走公开接口 + 既有事件）、ai/server/cli、AppRoot.tsx、screens/**、battleDriver/gameStore（只 import 既有 API——对局交互复用 gameStore 现有动作入口；若需要 gameStore 新能力，**不许改**，用 ui/tutorial 内独立实现绕行并汇报）、ui/preview|codex|replay|stats|keybinds（只读 import）、three/**、tokens.css（只读用既有令牌）。
**注意**：并行有 ENG1 代理在给引擎加电费抵扣券（core 语义微变：P2 起手多一张券）——你的教学对局也会看到券（P2 是脚本对手，忽略它即可；P1 教学卡组不受影响）。若发现券影响你的关卡设计，如实写 deviations。

## 验证与汇报

定向测试：过关判定纯函数（事件流→过关布尔，逐关构造事件样例）、动作白名单过滤、进度存取；禁跑全仓（并行代理在改 core，全仓测试会互踩）；禁 git commit/push。
汇报四字段：files / summary（控制器架构、各关卡组构成与判定、脚本对手编排、挂载约定）/ checks / deviations（如实——特别是并行期 core 在途变化对你影响的观察）。
