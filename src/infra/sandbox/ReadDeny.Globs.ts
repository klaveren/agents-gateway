import { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathGlobMatches } from '@domain/Permission.Policy'

/**
 * ⚡ AS NEGAÇÕES DE LEITURA COM CURINGA, EXPANDIDAS PELO GATEWAY (só no Linux, onde o runtime as varre).
 *
 * O runtime do cerco (`@anthropic-ai/sandbox-runtime`) transforma cada `<raiz>/**\/.env` em montagens VARRENDO o disco a
 * cada comando, no thread do servidor, seguindo cada link de pasta e resolvendo cada link com `realpathSync`, padrão por
 * padrão. Numa worktree pnpm isso atravessa o `node_modules/.pnpm` inteiro (~9 mil links): ~1 s por padrão na worktree,
 * ~3,5 s no repositório principal (que contém as worktrees). Com os padrões de segredo, as âncoras do projeto e o checkout
 * principal, um `pwd` custava minutos de CPU, e dois agentes juntos deixavam o servidor a 100% (26/11: o `run_bash` do
 * Antigravity passava dos 3 min do `agy`, e o turno acabava no teto de 10 min).
 *
 * Aqui: UMA varredura assíncrona por pasta-base (a listagem de cada pasta real é dividida entre os padrões), sem descer
 * em `node_modules` nem em `.git`, e o padrão vira os caminhos que existem e casam — onde moram de verdade. O runtime
 * recebe só caminhos literais.
 *
 * ⚖️ O que fica com o runtime (o padrão como veio, falha fechada): o padrão que nomeia `node_modules`/`.git`, o que usa
 * `[` `]` `{` `}`, o que começa na raiz do disco, a varredura que passa do teto e o padrão com casamentos demais.
 * ⚠️ O que mora DENTRO de `node_modules` não é mais escondido por esses padrões (o `.env` de um pacote). O segredo de
 * fora dele, alcançado por um link lá dentro, segue escondido: a montagem fica no caminho real.
 */

/** As pastas que a expansão não atravessa: dependências e o git por dentro. */
const SKIPPED = new Set(['node_modules', '.git'])
/** Teto de entradas por varredura: passou, o padrão fica com o runtime. */
export const READ_DENY_WALK_LIMIT = 200_000
/** Teto de caminhos por padrão (cada um é uma montagem no bwrap, que para em ~3000): passou, o padrão fica com o runtime. */
export const READ_DENY_MATCH_LIMIT = 1000

export interface IReadDenyFs {
  read(dir: string): Promise<Dirent[]>
  stat(path: string): Promise<{ isDirectory(): boolean }>
  realpath(path: string): Promise<string>
}

const nodeFs: IReadDenyFs = {
  read: (dir) => readdir(dir, { withFileTypes: true }),
  stat: (path) => stat(path),
  realpath: (path) => realpath(path),
}

interface IWalked {
  /** O caminho relativo à base (como o padrão o soletra) e onde ele mora. */
  entries: Array<{ rel: string; real: string }>
}

const hasWildcard = (segment: string) => /[*?]/.test(segment)

/** O padrão que a expansão sabe ler: absoluto, com `*`/`?`, sem classes nem chaves, sem nomear o que ela pula. */
function expandable(pattern: string): boolean {
  if (!isAbsolute(pattern) || !hasWildcard(pattern) || /[[\]{}]/.test(pattern)) return false
  return !pattern.split('/').some((segment) => SKIPPED.has(segment))
}

/** A pasta literal de onde o padrão parte (os trechos antes do primeiro curinga). */
function baseOf(pattern: string): string {
  const segments = pattern.split('/').filter(Boolean)
  const first = segments.findIndex(hasWildcard)
  return `/${segments.slice(0, first).join('/')}`
}

/** A árvore da base, em largura, com os links de pasta seguidos uma vez cada. `undefined` = passou do teto. */
async function walk(base: string, fs: IReadDenyFs, listings: Map<string, Promise<Dirent[] | undefined>>, limit: number): Promise<IWalked | undefined> {
  const entries: IWalked['entries'] = []
  let real: string
  try {
    real = await fs.realpath(base)
  } catch {
    return { entries }
  }
  const seen = new Set([real])
  const pending: Array<{ rel: string; real: string }> = [{ rel: '', real }]
  const list = (dir: string) => {
    let listed = listings.get(dir)
    if (!listed) {
      listed = fs.read(dir).catch(() => undefined)
      listings.set(dir, listed)
    }
    return listed
  }
  for (let next = 0; next < pending.length; next += 1) {
    const frame = pending[next]!
    const children = await list(frame.real)
    // A pasta que não se lista: o que ela tem não se sabe. Fica com o runtime (que a nega inteira).
    if (!children) return frame.rel ? undefined : { entries }
    for (const child of children) {
      if (SKIPPED.has(child.name)) continue
      if (entries.length >= limit) return undefined
      const rel = frame.rel ? `${frame.rel}/${child.name}` : child.name
      const path = join(frame.real, child.name)
      if (child.isSymbolicLink()) {
        let target: string
        let dir: boolean
        try {
          target = await fs.realpath(path)
          dir = (await fs.stat(target)).isDirectory()
        } catch {
          // Link quebrado: nada a esconder hoje; o caminho dele entra, como no runtime.
          entries.push({ rel, real: path })
          continue
        }
        entries.push({ rel, real: target })
        if (dir && !seen.has(target)) {
          seen.add(target)
          pending.push({ rel, real: target })
        }
        continue
      }
      entries.push({ rel, real: path })
      if (child.isDirectory() && !seen.has(path)) {
        seen.add(path)
        pending.push({ rel, real: path })
      }
    }
  }
  return { entries }
}

/** Os casamentos de um padrão numa varredura; `undefined` = casamentos demais. */
function matchesOf(pattern: string, base: string, walked: IWalked, limit: number): string[] | undefined {
  const rel = pattern.slice(base === '/' ? 1 : base.length + 1)
  // `x/**` vale também para a pasta `x` (a montagem sobre ela esconde o que tem dentro).
  const form = rel.endsWith('/**') ? rel.slice(0, -3) : undefined
  const found = new Set<string>()
  for (const entry of walked.entries) {
    if (!pathGlobMatches(rel, entry.rel) && !(form !== undefined && pathGlobMatches(form, entry.rel))) continue
    found.add(entry.real)
    if (found.size > limit) return undefined
  }
  // O que mora dentro de uma pasta casada já fica escondido com ela: uma montagem por baixo da outra o bwrap nem cria.
  const kept: string[] = []
  for (const path of [...found].sort()) if (!kept.some((dir) => path.startsWith(`${dir}/`))) kept.push(path)
  return kept
}

/**
 * As negações de leitura com os padrões trocados pelos caminhos que casam (ver o topo). Os caminhos sem curinga seguem
 * como vieram, na ordem; os expandidos entram no lugar do padrão.
 */
export async function expandReadDenyGlobs(paths: readonly string[], fs: IReadDenyFs = nodeFs, limits: { walk?: number; matches?: number } = {}): Promise<string[]> {
  const walkLimit = limits.walk ?? READ_DENY_WALK_LIMIT
  const matchLimit = limits.matches ?? READ_DENY_MATCH_LIMIT
  const listings = new Map<string, Promise<Dirent[] | undefined>>()
  const walks = new Map<string, Promise<IWalked | undefined>>()
  const out: string[] = []
  for (const path of paths) {
    if (!expandable(path)) {
      out.push(path)
      continue
    }
    const base = baseOf(path)
    // A raiz do disco: varrer o servidor inteiro não é expansão. Fica com o runtime.
    if (base === '/') {
      out.push(path)
      continue
    }
    // `<pasta>/**` sem outro curinga é a própria pasta.
    const rest = path.slice(base.length + 1)
    if (rest === '**') {
      out.push(base)
      continue
    }
    let walked = walks.get(base)
    if (!walked) {
      walked = walk(base, fs, listings, walkLimit)
      walks.set(base, walked)
    }
    const tree = await walked
    const found = tree && matchesOf(path, base, tree, matchLimit)
    if (found) out.push(...found)
    else out.push(path)
  }
  return [...new Set(out)]
}
