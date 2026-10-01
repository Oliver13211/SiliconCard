/**
 * @siliconcard/server — LAN 对战权威服务端（Node + ws）。
 *
 * 硬约束：服务端持有完整 GameState，客户端只收 viewFor 裁剪视图；
 * 上行仅 { type: 'action' }；消息带 seq，断线重连全量对齐；
 * mDNS 发现失败必须回退手动 IP 直连。
 *
 * 首个实现任务：M2-NET1 —— 见 docs/task-breakdown.md
 */
export const SERVER_VERSION = '0.0.1'
