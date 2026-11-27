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
 * Aqui: UMA varredura assíncrona e paralela por pasta-base (cada entrada casada com todos os padrões da base enquanto
 * ela anda), sem descer em `node_modules` nem em `.git`, e o padrão vira os caminhos que existem e casam — onde moram de
 * verdade. O runtime recebe só caminhos literais.
 *
 * ⚖️ O que fica com o runtime (o padrão como veio, falha fechada): o padrão que nomeia `node_modules`/`.git`, o que usa
 * `[` `]` `{` `}`, o que começa na raiz do disco, a varredura que passa do teto e o padrão com casamentos demais.
 * ⚠️ O que mora DENTRO de `node_modules` não é mais escondido por esses padrões (o `.env` de um pacote). O segredo de
 * fora dele, alcançado por um link lá dentro, segue escondido: a montagem fica no caminho real.
 */

/** As pastas que a expansão não atravessa: dependências e o git por dentro. */
const SKIPPED = new Set(['node_modules', '.git'])
/**
 * Teto de entradas por varredura: passou, o padrão fica com o runtime. ⚖️ Alto de propósito: a varredura não guarda a
 * árvore (casa enquanto anda), então o teto custa tempo de disco, não memória. Com 200 mil, a pasta de um projeto (o
 * rascunho dos agentes: o store do pnpm em `.home`, o cache do `tsx` em `.tmp`) passou do teto em 27/11, e cada `**`
 * dela voltou para a varredura SÍNCRONA do runtime: ~40 s de thread travado por comando de um agente na raiz do projeto.
 */
export const READ_DENY_WALK_LIMIT = 2_000_000
/** Teto de caminhos por padrão (cada um é uma montagem no bwrap, que para em ~3000): passou, o padrão fica com o runtime. */
export const READ_DENY_MATCH_LIMIT = 1000
/**
 * Quantas pastas (e links) a varredura lê ao mesmo tempo. ⚡ Uma de cada vez, cada leitura esperava uma volta inteira do
 * loop do servidor: ~11 mil leituras numa worktree custavam 1 s com o servidor parado e 1–3 min com ele ocupado (27/11: o
 * `run_bash` e o `bash_start` da Vera levavam 50–170 s para nascer, enquanto o `read_file` respondia na hora). Em
 * paralelo, as voltas caem para ~1/32.
 */
export const READ_DENY_WALK_CONCURRENCY = 32

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

/**
 * Processa a fila com até `concurrency` tarefas em voo; a tarefa pode crescer a fila (largura: quem entrou antes sai
 * antes). Para cedo quando `stop()` diz que sim; espera as que já estão em voo. Uma tarefa que falha, rejeita.
 */
export function drainConcurrently<T>(queue: T[], concurrency: number, work: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<void> {
  return new Promise((resolve, reject) => {
    let next = 0
    let active = 0
    let failed = false
    const pump = () => {
      if (failed) return
      while (!stop() && active < concurrency && next < queue.length) {
        const item = queue[next]!
        next += 1
        active += 1
        work(item).then(
          () => {
            active -= 1
            pump()
          },
          (error: unknown) => {
            failed = true
            reject(error)
          },
        )
      }
      if (active === 0 && (stop() || next >= queue.length)) resolve()
    }
    pump()
  })
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

/** Um padrão sendo procurado numa varredura: o trecho relativo à base, o que casou e se passou do teto. */
interface ISought {
  pattern: string
  rel: string
  /** `x/**` vale também para a pasta `x` (a montagem sobre ela esconde o que tem dentro). */
  form?: string
  found: Set<string>
  overflow: boolean
}

function soughtOf(pattern: string, base: string): ISought {
  const rel = pattern.slice(base === '/' ? 1 : base.length + 1)
  return { pattern, rel, ...(rel.endsWith('/**') ? { form: rel.slice(0, -3) } : {}), found: new Set(), overflow: false }
}

/**
 * A árvore da base, em largura e em paralelo, com os links de pasta seguidos uma vez cada; cada entrada é casada com os
 * padrões da base na hora (nada da árvore fica guardado). `false` = a varredura não terminou (passou do teto, ou uma
 * pasta do meio não se lista): os padrões dela ficam com o runtime.
 */
async function walk(base: string, sought: ISought[], fs: IReadDenyFs, limits: { walk: number; matches: number; concurrency: number }): Promise<boolean> {
  let real: string
  try {
    real = await fs.realpath(base)
  } catch {
    // A base não existe: nada a esconder.
    return true
  }
  const seen = new Set([real])
  const pending: Array<{ rel: string; real: string }> = [{ rel: '', real }]
  let count = 0
  let incomplete = false
  const visit = (rel: string, path: string) => {
    for (const item of sought) {
      if (item.overflow || !(pathGlobMatches(item.rel, rel) || (item.form !== undefined && pathGlobMatches(item.form, rel)))) continue
      item.found.add(path)
      if (item.found.size > limits.matches) item.overflow = true
    }
  }
  const enqueue = (rel: string, dir: string) => {
    if (seen.has(dir)) return
    seen.add(dir)
    pending.push({ rel, real: dir })
  }
  await drainConcurrently(
    pending,
    limits.concurrency,
    async (frame) => {
      let children: Dirent[]
      try {
        children = await fs.read(frame.real)
      } catch {
        // A pasta que não se lista: o que ela tem não se sabe. Fica com o runtime (que a nega inteira); a base, nada a esconder.
        if (frame.rel) incomplete = true
        return
      }
      const links: Array<{ rel: string; path: string }> = []
      for (const child of children) {
        if (SKIPPED.has(child.name)) continue
        count += 1
        if (count > limits.walk) {
          incomplete = true
          return
        }
        const rel = frame.rel ? `${frame.rel}/${child.name}` : child.name
        const path = join(frame.real, child.name)
        if (child.isSymbolicLink()) links.push({ rel, path })
        else {
          visit(rel, path)
          if (child.isDirectory()) enqueue(rel, path)
        }
      }
      await Promise.all(
        links.map(async ({ rel, path }) => {
          let target: string
          let dir: boolean
          try {
            target = await fs.realpath(path)
            dir = (await fs.stat(target)).isDirectory()
          } catch {
            // Link quebrado: nada a esconder hoje; o caminho dele entra, como no runtime.
            visit(rel, path)
            return
          }
          visit(rel, target)
          if (dir) enqueue(rel, target)
        }),
      )
    },
    () => incomplete,
  )
  return !incomplete
}

/** O que mora dentro de uma pasta casada já fica escondido com ela: uma montagem por baixo da outra o bwrap nem cria. */
function outermost(found: Set<string>): string[] {
  const kept: string[] = []
  for (const path of [...found].sort()) if (!kept.some((dir) => path.startsWith(`${dir}/`))) kept.push(path)
  return kept
}

/**
 * As negações de leitura com os padrões trocados pelos caminhos que casam (ver o topo). Os caminhos sem curinga seguem
 * como vieram, na ordem; os expandidos entram no lugar do padrão.
 */
export async function expandReadDenyGlobs(
  paths: readonly string[],
  fs: IReadDenyFs = nodeFs,
  limits: { walk?: number; matches?: number; concurrency?: number } = {},
): Promise<string[]> {
  const bounds = { walk: limits.walk ?? READ_DENY_WALK_LIMIT, matches: limits.matches ?? READ_DENY_MATCH_LIMIT, concurrency: limits.concurrency ?? READ_DENY_WALK_CONCURRENCY }
  // Uma varredura por base, com todos os padrões dela; as bases andam juntas.
  const byBase = new Map<string, ISought[]>()
  const plan = paths.map((path): string | ISought => {
    if (!expandable(path)) return path
    const base = baseOf(path)
    // A raiz do disco: varrer o servidor inteiro não é expansão. Fica com o runtime.
    if (base === '/') return path
    // `<pasta>/**` sem outro curinga é a própria pasta.
    if (path.slice(base.length + 1) === '**') return base
    const item = soughtOf(path, base)
    byBase.set(base, [...(byBase.get(base) ?? []), item])
    return item
  })
  const complete = new Map<string, boolean>()
  await Promise.all([...byBase].map(async ([base, sought]) => complete.set(base, await walk(base, sought, fs, bounds))))
  const out: string[] = []
  for (const entry of plan) {
    if (typeof entry === 'string') out.push(entry)
    else if (!entry.overflow && complete.get(baseOf(entry.pattern))) out.push(...outermost(entry.found))
    else out.push(entry.pattern)
  }
  return [...new Set(out)]
}
