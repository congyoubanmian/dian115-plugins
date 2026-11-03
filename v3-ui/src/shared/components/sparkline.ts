// 迷你折线的纯函数路径计算。
//
// 原样从 chase-rs/visuals.ts 的 sparkPath(series, width, height) 移入：
// 只做几何计算，不 import 任何插件模块，避免 shared 反向耦合 chase、
// 把 chase 的业务代码带进 douban / music 的打包产物。
//
// 坐标约定：viewBox 宽 100、高 28（调用方可覆盖），y 轴向下；
// 少于 2 个点时返回空串，调用方据此不画折线（绝不编造数据）。

/** 折线路径（viewBox 100×28）；少于 2 个点返回空串。 */
export function sparkPath(
  series: number[],
  width = 100,
  height = 28,
): { line: string; area: string } {
  if (series.length < 2) return { line: '', area: '' }
  const max = Math.max(1, ...series)
  const stepX = width / (series.length - 1)
  const points = series.map((value, i) => [i * stepX, height - 2 - (value / max) * (height - 4)] as const)
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  return { line, area: `${line} L${width} ${height} L0 ${height} Z` }
}
