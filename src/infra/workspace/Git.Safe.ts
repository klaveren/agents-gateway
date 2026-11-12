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

/**
 * ⛔ SEM TRANSPORTE. O git do servidor só LÊ o repositório: nunca busca nada. Num repositório marcado como clone
 * parcial (`extensions.partialClone` + `remote.<nome>.promisor`, tudo config que o agente escreve), o objeto que falta
 * faz o diff rodar um `git fetch` sozinho, e o fetch roda programa da config: o `remote.<nome>.uploadpack`, o
 * ajudante `git-remote-<nome>` (que pode ser um alias ou um executável da própria pasta), o `core.sshCommand`. Fora
 * isso, é saída de rede do servidor, por fora do cerco.
 * `GIT_ALLOW_PROTOCOL` vazio recusa todo protocolo e, por ser ambiente, vence o `protocol.<nome>.allow` da config do
 * repositório (o `-c protocol.allow=never` perderia para ele). `GIT_NO_LAZY_FETCH` (git 2.45+) nem tenta a busca.
 */
const NO_TRANSPORT = { GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' } as const

/** A árvore vazia: o git a conhece sem o objeto existir no repositório. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * ⛔ O GIT DO GATEWAY, FORA DO CERCO. O agente grava na pasta e no `.git` dela: o `.git` (arquivo de worktree), o
 * `commondir` e o `.gitattributes` são dele. Por isso o git NUNCA descobre o repositório sozinho: `GIT_DIR`,
 * `GIT_COMMON_DIR` e `GIT_WORK_TREE` vão do servidor, e nada do que está na pasta aponta o git para outro lugar.
 * Também sem nada que execute programa: sem fsmonitor, diff externo, textconv, filtros (`.gitattributes` fora, ver
 * `GIT_ATTR_SOURCE`), hooks, config do sistema ou do usuário, pager, pergunta de senha, transporte (`NO_TRANSPORT`).
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
    ...NO_TRANSPORT,
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
  // Submódulo: a segunda camada (a primeira, que o `.gitmodules` não vence, é `SUBMODULE_FLAGS`).
  '-c',
  'diff.ignoreSubmodules=dirty',
  '-c',
  'diff.submodule=short',
  '-c',
  'status.submoduleSummary=false',
  '-c',
  'submodule.recurse=false',
  '-c',
  'fetch.recurseSubmodules=false',
  // Assinatura: o `log.showSignature` da config faz o log rodar o `gpg.program` (também da config) a cada commit.
  '-c',
  'log.showSignature=false',
  '-c',
  'gpg.program=/dev/null',
  '-c',
  'gpg.ssh.program=/dev/null',
  '-c',
  'gpg.x509.program=/dev/null',
]

/** Opções do git que levam o valor no argumento seguinte, antes do subcomando. */
const GLOBAL_VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--attr-source', '--list-cmds'])

/**
 * ⛔ SUBMÓDULO E REPOSITÓRIO ANINHADO. Para saber se um submódulo mudou, o diff e o status rodam OUTRO git dentro
 * dele, com a config DELE: e essa o agente escreve (um `git init` numa subpasta, um gitlink no índice). As travas
 * por `-c` chegam a esse git, mas os filtros de lá têm nomes que daqui não se conhecem. Por isso ele não é aberto:
 * `--ignore-submodules=dirty` na LINHA DE COMANDO (pela config não basta: o `.gitmodules`, que o agente escreve, a
 * vence). A troca de commit do submódulo continua a aparecer; o que mudou dentro dele, não. `--submodule=short`
 * impede o diff de pedir o log ou o diff de dentro. No diff vão junto `--no-ext-diff` e `--no-textconv`: com o
 * `diff.external` vazio, o diff em formato de patch sem eles morre tentando rodar um programa sem nome.
 */
const SUBMODULE_FLAGS: Record<string, readonly string[]> = {
  diff: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--submodule=short'],
  status: ['--ignore-submodules=dirty'],
}

/** Os argumentos com as travas do subcomando postas logo depois dele: quem chama não tem como esquecer. */
function withSubcommandFlags(args: readonly string[]): string[] {
  for (let i = 0; i < args.length; i++) {
    if (GLOBAL_VALUE_OPTIONS.has(args[i])) i++
    else if (!args[i].startsWith('-')) {
      const flags = Object.hasOwn(SUBMODULE_FLAGS, args[i]) ? SUBMODULE_FLAGS[args[i]] : []
      return [...args.slice(0, i + 1), ...flags, ...args.slice(i + 1)]
    }
  }
  return [...args]
}

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
  return ['-C', place.dir, ...SAFE_GIT_CONFIG, ...filtersOff(place), ...withSubcommandFlags(args)]
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

/**
 * ⛔ O git que DESCOBRE o repositório a partir de uma pasta (sem `IGitPlace`: a pasta é a que o agente escolheu, ou a
 * que a varredura percorre). O `.git` que ele acha pode ter sido criado pelo agente: as mesmas travas, o mesmo
 * ambiente sem transporte e sem os segredos do servidor. A config do usuário do servidor fica (é dele, e traz o
 * `safe.directory`). `undefined` fora de repositório ou se o git falhar.
 */
export function discoveredGitSync(dir: string, args: readonly string[], options: { timeout?: number } = {}): string | undefined {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...NO_TRANSPORT }
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'GIT_CEILING_DIRECTORIES']) if (process.env[name] !== undefined) env[name] = process.env[name]
  try {
    return execFileSync('git', ['-C', dir, ...SAFE_GIT_CONFIG, ...withSubcommandFlags(args)], {
      encoding: 'utf8',
      timeout: options.timeout ?? 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    })
  } catch {
    return undefined
  }
}
