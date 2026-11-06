import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Onde o git roda: a pasta e o git DELA, calculados pelo servidor (`resolveWorkFolder`), nunca lidos do que o agente
 * escreve. Sem `gitCommonDir` a pasta não é um repositório.
 */
export interface IGitPlace {
  dir: string
  /** O `.git` do repositório. */
  gitCommonDir?: string
  /** O diretório git da worktree (`<repo>/.git/worktrees/<nome>`); ausente no modo só repositório. */
  worktreeGitDir?: string
}

/** A árvore vazia: o git a conhece sem o objeto existir no repositório. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * ⛔ O GIT DO GATEWAY, FORA DO CERCO. O agente grava na pasta e no `.git` dela: o `.git` (arquivo de worktree), o
 * `commondir` e o `.gitattributes` são dele. Por isso o git NUNCA descobre o repositório sozinho: `GIT_DIR`,
 * `GIT_COMMON_DIR` e `GIT_WORK_TREE` vão do servidor, e nada do que está na pasta aponta o git para outro lugar.
 * Também sem nada que execute programa: sem fsmonitor, diff externo, textconv, filtros (`.gitattributes` fora, ver
 * `GIT_ATTR_SOURCE`), hooks, config do sistema ou do usuário, pager, pergunta de senha.
 */
export function safeGitEnv(place: IGitPlace): NodeJS.ProcessEnv {
  if (!place.gitCommonDir) throw new Error('git: a pasta não é um repositório')
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/nonexistent',
    GIT_DIR: place.worktreeGitDir ?? place.gitCommonDir,
    GIT_COMMON_DIR: place.gitCommonDir,
    GIT_WORK_TREE: place.dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_SOURCE: EMPTY_TREE,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

/** As travas por `-c`, antes do subcomando. */
export const SAFE_GIT_CONFIG: readonly string[] = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.pager=cat',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'diff.noprefix=false',
]

const FILTER_KEY = /^filter\.(.+)\.(?:clean|smudge|process|required)$/
const filterCache = new Map<string, { at: number; args: string[] }>()

/**
 * ⛔ Os filtros da config (`filter.<nome>.clean|smudge|process`) desligados um a um: o `.gitattributes` do repositório
 * (ou o `info/attributes`) manda aplicar o filtro a cada arquivo que o diff e o status leem. O `GIT_ATTR_SOURCE` vazio
 * tira os atributos da árvore, mas não os do `info/attributes`: por isso o comando de cada filtro sai também, lido com
 * a config já travada. Guardado por 5 s por repositório.
 */
function filtersOff(place: IGitPlace): string[] {
  const key = `${place.gitCommonDir}\0${place.worktreeGitDir ?? ''}\0${place.dir}`
  const hit = filterCache.get(key)
  if (hit && Date.now() - hit.at < 5000) return hit.args
  const names = new Set<string>()
  try {
    const out = execFileSync('git', ['-C', place.dir, ...SAFE_GIT_CONFIG, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: safeGitEnv(place),
    })
    for (const name of out.split('\0')) {
      const match = FILTER_KEY.exec(name)
      if (match) names.add(match[1])
    }
  } catch {
    // Sem filtro na config (o git sai com 1): nada a desligar.
  }
  const args = [...names].flatMap((name) => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`])
  filterCache.set(key, { at: Date.now(), args })
  return args
}

function argv(place: IGitPlace, args: readonly string[]): string[] {
  return ['-C', place.dir, ...SAFE_GIT_CONFIG, ...filtersOff(place), ...args]
}

/** O git endurecido, assíncrono. */
export async function safeGit(place: IGitPlace, args: readonly string[], options: { maxBuffer?: number; timeout?: number } = {}): Promise<string> {
  const { stdout } = await run('git', argv(place, args), {
    encoding: 'utf8',
    timeout: options.timeout ?? 15_000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    env: safeGitEnv(place),
  })
  return stdout
}

/** O git endurecido, síncrono; `undefined` se falhar. */
export function safeGitSync(place: IGitPlace, args: readonly string[], options: { maxBuffer?: number; timeout?: number } = {}): string | undefined {
  try {
    return execFileSync('git', argv(place, args), {
      encoding: 'utf8',
      timeout: options.timeout ?? 15_000,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: safeGitEnv(place),
    })
  } catch {
    return undefined
  }
}
