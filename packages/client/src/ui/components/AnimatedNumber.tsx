/**
 * 数值脉冲（UI 现代化）：值变化时数字弹跳 + 提亮一次。
 *
 * 实现零状态：以 `key={value}` 让 span 在数值变化时重挂载，触发 motion.css 的
 * `sc-num-pop` 关键帧（scale + brightness，纯 transform/filter 不触发 layout）。
 * 轻量 JS 仅此一处，不引入任何动画依赖。
 */

export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  return (
    <span key={value} className={className ? `sc-num ${className}` : 'sc-num'}>
      {value}
    </span>
  )
}
