// 动效小工具：尊重系统的「减少动态效果」设置。
//
// CSS 侧用 @media (prefers-reduced-motion: reduce) 关掉动画；
// 脚本驱动的动效（数字滚动、海报倾斜、轮播平滑滚动）在这里统一判断。

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  } catch {
    return false
  }
}

/** 豆瓣评分（0~10 的字符串/数字）→ 0~100 的百分比；无评分返回 -1。 */
export function ratingPercent(value: unknown): number {
  const score = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(score) || score <= 0) return -1
  return Math.max(0, Math.min(100, score * 10))
}
