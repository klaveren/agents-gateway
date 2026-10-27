import type { IFootprintSection } from './types'

/** As cores das partes, na ordem em que aparecem (a barra e a lista usam a mesma). */
const COLORS = ['bg-emerald-500', 'bg-sky-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-400', 'bg-indigo-400', 'bg-lime-500', 'bg-fuchsia-500', 'bg-orange-400']

/** Cada parte medida com a fatia dela no total (0–100) e a cor. As não medidas ficam com 0 e cinza. */
export function footprintShares(sections: readonly IFootprintSection[]): Array<IFootprintSection & { share: number; color: string }> {
  const total = sections.reduce((sum, section) => sum + (section.tokens ?? 0), 0)
  let measured = 0
  return sections.map((section) => {
    if (section.tokens === null || !total) return { ...section, share: 0, color: 'bg-zinc-700' }
    const color = COLORS[measured++ % COLORS.length]
    return { ...section, share: Math.round((section.tokens / total) * 1000) / 10, color }
  })
}
