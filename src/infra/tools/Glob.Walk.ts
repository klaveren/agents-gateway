import { Dirent } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { join, matchesGlob } from 'node:path'
import { drainConcurrently } from '@infra/sandbox/ReadDeny.Globs'

/**
 * ⚡ O GLOB DAS TOOLS DE ARQUIVO (`list_files`, `search_files`), em largura e em paralelo.
 *
 * O `glob` do Node lê uma pasta por vez: cada leitura espera uma volta inteira do loop do servidor. Numa pasta de 200 mil
 * entradas, com o servidor ocupado, a busca levava minutos (27/11: um `search_files` da Vera bateu os 170 s). Aqui as
 * pastas são lidas `GLOB_WALK_CONCURRENCY` de cada vez, e o casamento é o do próprio Node (`path.matchesGlob`).
 *
 * ⚖️ Como o `glob` do Node: os trechos literais do começo do padrão (que podem passar por link) escolhem a pasta de
 * partida; `*`, `?` e `**` não casam nome que começa com ponto; `x/**` inclui a própria `x`; `x/` só casa pasta. Diferente:
 * dentro da varredura, link de pasta é listado e não seguido (o Node às vezes descia um nível).
 */

export const GLOB_WALK_CONCURRENCY = 32

export interface IGlobWalk {
  /** Os caminhos relativos ao `cwd`, ordenados. */
  names: string[]
  /** A varredura parou no teto (`max` entradas lidas): o resultado é parcial. */
  capped: boolean
}

const hasGlob = (segment: string) => /[*?[\]{}]/.test(segment)

/** O padrão, limpo: sem `./` do começo nem barras repetidas; `dirsOnly` quando termina em `/`. */
function parse(pattern: string): { segments: string[]; dirsOnly: boolean } {
  const clean = pattern.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  return { segments: clean.split('/').filter((segment) => segment && segment !== '.'), dirsOnly: clean.endsWith('/') }
}

export async function globWalk(cwd: string, pattern: string, options: { skip: ReadonlySet<string>; max: number; concurrency?: number }): Promise<IGlobWalk> {
  const { segments, dirsOnly } = parse(pattern)
  if (!segments.length || segments.some((segment) => options.skip.has(segment))) return { names: [], capped: false }
  const first = segments.findIndex(hasGlob)
  const base = first === -1 ? segments : segments.slice(0, first)
  const rest = first === -1 ? [] : segments.slice(first)
  const glob = segments.join('/')
  const prefix = base.join('/')

  let start: string
  try {
    start = await realpath(join(cwd, ...base))
  } catch {
    return { names: [], capped: false }
  }
  // Sem curinga: é o próprio caminho (se existe).
  if (!rest.length) {
    if (!dirsOnly) return { names: [prefix], capped: false }
    try {
      await readdir(start)
      return { names: [prefix], capped: false }
    } catch {
      return { names: [], capped: false }
    }
  }

  // Até onde descer: sem `**`, o número de trechos que faltam. Pasta de ponto só entra se algum trecho começa com ponto.
  const deep = rest.includes('**')
  const maxDepth = deep ? Infinity : rest.length
  const dotted = rest.some((segment) => segment.startsWith('.'))
  const selfToo = glob.endsWith('/**') ? glob.slice(0, -3) : undefined
  const matches = (rel: string) => matchesGlob(rel, glob) || (selfToo !== undefined && matchesGlob(rel, selfToo))

  const names: string[] = []
  // `x/**`: a própria pasta de partida entra, como no `glob` do Node.
  if (prefix && selfToo === prefix) names.push(prefix)
  const seen = new Set([start])
  const pending: Array<{ rel: string; real: string; depth: number }> = [{ rel: prefix, real: start, depth: 0 }]
  let count = 0
  let capped = false
  await drainConcurrently(
    pending,
    options.concurrency ?? GLOB_WALK_CONCURRENCY,
    async (frame) => {
      let children: Dirent[]
      try {
        children = await readdir(frame.real, { withFileTypes: true })
      } catch {
        return // a pasta que não se lista (permissão, sumiu no caminho): fica de fora
      }
      for (const child of children) {
        if (options.skip.has(child.name)) continue
        count += 1
        if (count > options.max) {
          capped = true
          return
        }
        const rel = frame.rel ? `${frame.rel}/${child.name}` : child.name
        const dir = child.isDirectory()
        if ((!dirsOnly || dir) && matches(rel)) names.push(rel)
        if (!dir || frame.depth + 1 >= maxDepth || (child.name.startsWith('.') && !dotted)) continue
        const real = join(frame.real, child.name)
        if (seen.has(real)) continue
        seen.add(real)
        pending.push({ rel, real, depth: frame.depth + 1 })
      }
    },
    () => capped,
  )
  return { names: names.sort(), capped }
}
