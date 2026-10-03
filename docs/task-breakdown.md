# 硅牌 SiliconCard · 任务拆分（WBS）

> 配套文档：[design-report.md](./design-report.md) · [agent 预设](./agents/presets.md) · [workflow](./agents/workflows.md)
> 任务 ID 规则：`<里程碑>-<类型><序号>`。类型前缀：INF 基建 / ENG 引擎 / CNT 内容 / R3D 3D渲染 / UI 界面 / AI 人机 / NET 联机 / AGT Agent接口 / QA 质量 / DOC 文档
> 每个任务标注**执行 agent 预设**，详见 [presets.md](./agents/presets.md)
> **进度注记（2026-10-03）**：✅ **M0 全部完成**。✅ **M1 引擎链 M1-ENG1..7 闭环**（core 0.1.0）。✅ **M1 其余四线经动态工作流并行完成**：M1-R3D1..4（渲染）、M1-UI1..3（界面+接线）、M1-QA1（覆盖率门禁 97%/90%/100%/97% ≥85）、M1-CNT 四批 60 卡（N/A/I/中立）+ 4 套预组卡组 + 集成接线——全仓门禁全绿（core 421 + client 116 例）。待办：M1-INF4（Pages 部署，待人工画面验收）；WF-VISUAL 浏览器视觉验收；M1-AI1（内置人机）；M2/M3/M4 里程碑。

---

## M0 · 立项基建

| ID | 任务 | Agent | 依赖 | 验收标准 |
|---|---|---|---|---|
| M0-INF1 | yarn workspaces 单仓初始化：`packages/{core,content,ai,client,server,cli}` 骨架、TS 配置、ESLint+Prettier | devops | 无 | `yarn install && yarn build && yarn lint` 全绿 |
| M0-INF2 | client 包接 Vite + React：dev server、HMR、路径别名 | devops | M0-INF1 | `yarn dev` 打开空白牌桌占位页 |
| M0-INF3 | GitHub Actions CI：lint + test + build，PR 与 main 触发 | devops | M0-INF1 | PR 状态检查生效 |
| M0-DOC1 | 规则书 v1（docs/rules.md）：卡牌 schema 字段定稿、事件目录定稿、关键词效果精确定义 | engine-dev | M0-INF1 | schema 与事件目录被后续任务引用且不再频繁变更 |
| M0-ENG1 | core 包类型定义：`GameState / Action / GameEvent / PlayerView / DeckSpec` 与引擎接口签名 | engine-dev | M0-DOC1 | 类型导出通过编译；黄金回放测试框架就位 |

## M1 · 可玩 MVP

### 引擎（engine-dev，串行为主）

| ID | 任务 | Agent | 依赖 | 验收标准 |
|---|---|---|---|---|
| M1-ENG1 | 回合机：回合流转、供电曲线、抽牌与手牌上限、疲劳 | engine-dev | M0-ENG1 | 单测覆盖全部回合状态转移 |
| M1-ENG2 | 出牌结算：功耗校验、gpu 入场召唤、driver 结算、accessory 光环 | engine-dev | M1-ENG1 | 单测含非法操作拒绝（RuleError） |
| M1-ENG3 | 攻击结算：攻击宣告、嘲讽（信仰充值）强制、攻击次数（双芯 GPU）、入场召唤失调 | engine-dev | M1-ENG2 | 单测覆盖关键词拦截路径 |
| M1-ENG4 | 关键词系统：三年质保、无输出亮机、蓝屏/传家宝亡语、跳闸 | engine-dev | M1-ENG3 | 每个关键词 ≥3 条单测（触发/不触发/叠加） |
| M1-ENG5 | 派系技能框架 + 首批 4 个技能（DLSS/开光追试试/驱动更新/清灰，含 30% 失败的种子随机） | engine-dev | M1-ENG2 | 随机结果可由 seed 复现 |
| M1-ENG6 | 效果原语库：伤害/治疗/召唤/buff/抽牌/摧毁/复活/关键词增删，+ 战吼/亡语触发框架 | engine-dev | M1-ENG2 | 原语组合能表达 §2.5 全部示例牌 |
| M1-ENG7 | 胜负判定 + 结算事件（R.I.P 烧了）+ 回放序列化（seed+actions 存档） | engine-dev | M1-ENG5 | 黄金回放：3 局完整对局快照锁定 |

### 内容（card-content，可与引擎并行度低，但按批产出）

| ID | 任务 | Agent | 依赖 | 验收标准 |
|---|---|---|---|---|
| M1-CNT1 | 卡池批次 1（~15 张）：NVIDIA 派系 + 对应效果函数注册 | card-content | M1-ENG6 | 每卡三件套：JSON + 效果 + 单测；卡面可渲染 |
| M1-CNT2 | 卡池批次 2（~15 张）：AMD 派系（含矿卡子类） | card-content | M1-ENG6 | 同上 |
| M1-CNT3 | 卡池批次 3（~15 张）：Intel 派系 | card-content | M1-ENG6 | 同上 |
| M1-CNT4 | 卡池批次 4（~15 张）：中立通用硬件（散热/电源/主板/内存/外设） | card-content | M1-ENG6 | 同上；预组卡组 ≥4 套（每派系一套+全能中立套） |

### 客户端（client-3d 与 client-ui 可并行）

| ID | 任务 | Agent | 依赖 | 验收标准 |
|---|---|---|---|---|
| M1-R3D1 | Three 场景管理器：牌桌场景、相机（含演出机位）、灯光、canvas 挂载与 resize | client-3d | M0-INF2 | 60fps 空场景，无内存泄漏 |
| M1-R3D2 | 程序化卡面绘制器：按 `art` 参数 + 派系色板绘制卡面 CanvasTexture（卡框/费用圆环/攻血角标/名称） | client-3d | M0-DOC1 | 全部卡池数据可渲染出卡面；派系色一眼可辨 |
| M1-R3D3 | 卡牌实体与手牌：卡牌 mesh、手牌扇形布局、raycasting 拾取、hover 抬起 | client-3d | M1-R3D1,2 | 手牌交互流畅，拾取准确 |
| M1-R3D4 | 事件→动画映射：抽牌飞入、出牌落场、攻击冲撞、伤害飘字、死亡碎裂、跳闸闪屏、烧卡冒烟 | client-3d | M1-ENG7, M1-R3D3 | §3.2 事件目录全部有动画或明确豁免；支持快进 |
| M1-UI1 | React HUD：血量/护甲、功耗条、扩展槽指示、回合按钮、战报日志、牌库计数 | client-ui | M0-ENG1 | 与引擎状态实时同步（zustand） |
| M1-UI2 | 出牌与目标选择流：手牌点击→目标高亮→确认；派系技能按钮 | client-ui | M1-UI1, M1-R3D3 | 仅合法操作可点（getLegalActions 驱动） |
| M1-UI3 | 菜单闭环：主菜单→选派系/卡组→对战→结算画面（R.I.P 烧了）→再来一局 | client-ui | M1-UI2 | 陌生人 5 分钟内完成首局（含规则页） |
| M1-AI1 | 内置人机 Normal：启发式评估（场面交换价值、直伤择优、费用曲线填充） | game-ai | M1-ENG7 | 通过 CLI 自对弈 100 局无崩溃、无非法操作 |
| M1-QA1 | 黄金回放锁定 + core 单测覆盖率 ≥85% | qa-balance | M1-ENG7 | CI 强制 |
| M1-INF4 | GitHub Pages 部署流水线 + 线上冒烟 | devops | M1-UI3 | 公网可玩 |

## M3 · Agent 接口（默认先于 M2）

| ID | 任务 | Agent | 依赖 | 验收标准 |
|---|---|---|---|---|
| M3-AGT1 | cli 包：JSON 行协议对局（`{state,legalActions}` → `{action}`）、难度与 seed 参数 | agent-liaison | M1-ENG7 | 外部进程可完成一整局 |
| M3-AGT2 | docs/agent-skill.md：给 AI agent 的规则速查 skill（规则摘要、动作 schema、策略提示） | agent-liaison | M3-AGT1 | 新会话的 coding agent 仅凭此文档能打满一局 |
| M3-AGT3 | 演示 agent（脚本调用内置 AI 或简单策略）+ README 挑战说明 | agent-liaison | M3-AGT2 | 一条命令即可让 agent 观战/对战 |
| M3-AGT4 | （可选）MCP server 包装 | agent-liaison | M3-AGT1 | MCP 工具可开局/查看/出牌 |

## M2 · 局域网对战

| ID | 任务 | Agent | 依赖 | 验收标准 |
|---|---|---|---|---|
| M2-NET1 | server 包：ws 权威服务端、`viewFor` 视图下发、action 上行校验 | net-dev | M1-ENG7 | 双客户端脚本对跑 100 局无状态漂移 |
| M2-NET2 | 房间系统：建房/加入/房间码 + mDNS 局域网发现 | net-dev | M2-NET1 | 两设备零配置互见 |
| M2-NET3 | 断线重连（seq 续传）+ 服务端 AI 虚拟玩家托管 | net-dev, game-ai | M2-NET2 | 杀进程重连 30s 内恢复对局 |
| M2-UI4 | 联机 UI：建房/加入/等待/重连提示 | client-ui | M2-NET2 | 联机全流程不出 DOM |

## M4 · 内容量与平衡

| ID | 任务 | Agent | 依赖 | 验收标准 |
|---|---|---|---|---|
| M4-CNT5 | Apple Silicon / 高通 / ARM Mali 派系卡池（~30 张）+ 3 个新派系技能 | card-content | M1-CNT4 | 同 M1 内容标准 |
| M4-QA2 | 平衡管线：CLI 自对弈批量跑分 → 派系胜率报告 → 数值调整 | qa-balance | M3-AGT1 | 派系胜率极差 <10% |
| M4-R3D5 | 演出升级：派系技能专属动画、传说卡入场演出、牌桌主题 | client-3d | M1-R3D4 | 传说卡有专属演出 |
| M4-SND1 | 音效与音乐（占位音效转正 + BGM） | card-content | M1-UI3 | 全对局流程有声音反馈 |

---

## 依赖关系与并行度总览

```
M0-INF1 ─┬─ M0-INF2 ─┬─ M0-DOC1 ─ M0-ENG1 ═══ M1-ENG1..7（串行链）═══╗
         └─ M0-INF3   │                                              ║
                      └─ M1-R3D1/2/3 ── M1-R3D4 ─────────────────────╬─ M1-INF4（发布）
                  M1-CNT1..4（依赖 ENG6，四批内部可并行）─────────────╣
                  M1-UI1/2/3（依赖 ENG1 起可开始搭壳）────────────────╣
                  M1-AI1（依赖 ENG7）────────────────────────────────╣
                  M1-QA1（依赖 ENG7）────────────────────────────────╝
M1-ENG7 ── M3-AGT1..3（Agent 线）   M1-ENG7 ── M2-NET1..3 + M2-UI4（LAN 线）
```

- 引擎链（ENG1→7）是关键路径，最高优先级；
- 内容四批在 ENG6 完成后可开 4 个并行 card-content；
- 客户端 3D 与 UI 两线全程并行；
- M3（Agent）与 M2（LAN）互不依赖，各自仅依赖 M1-ENG7。
