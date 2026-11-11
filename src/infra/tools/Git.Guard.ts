import { existsSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { IShellCommand } from '@infra/permissions/Shell.Parse'

/** As travas de git desta instalação (as Configurações): ver `gitGuard`. */
export interface IGitGuardOptions {
  /** Trocar de branch na pasta principal de um repositório (padrão: travado). */
  lockMainCheckout: boolean
  /** As branches que só recebem por PR: `git push` direto nelas é recusado. Vazia = nenhuma. */
  protectedBranches: readonly string[]
  /** O prefixo das branches desta instalação (`henrique/`): branch nova sem ele ganha aviso. */
  branchPrefix?: string
}

export interface IGitGuardResult {
  refusal?: string
  notes: string[]
}

/**
 * ⛔ AS TRAVAS DE GIT DO TERMINAL, sem depender de regra:
 *
 * - TROCAR DE BRANCH NA PASTA PRINCIPAL do repositório (`git checkout <branch>`, `git switch`) troca o ambiente inteiro —
 *   o que roda e recarrega lê dela. O trabalho com branch é numa WORKTREE (a pasta que o `.git` é arquivo). Restaurar um
 *   arquivo (`git checkout -- x`, `git checkout x` com `x` existente) segue livre;
 * - `git push` direto numa BRANCH PROTEGIDA (a `automation`, a `main`, as das Configurações): só por PR. O alvo sai do
 *   refspec, ou da branch atual quando não há; `--all` e `--mirror` com proteção ativa, recusados;
 * - branch NOVA fora do prefixo desta instalação: só aviso (dois gateways no mesmo remoto não colidem).
 *
 * ⚖️ A pasta segue os `cd` e o `-C` do próprio comando. `--git-dir`/`--work-tree` não são seguidos: a trava vale pela pasta.
 */
export function gitGuard(commands: readonly IShellCommand[], root: string, options: IGitGuardOptions, currentBranch: (dir: string) => string | undefined): IGitGuardResult {
  const notes: string[] = []
  let dir = root
  for (const command of commands) {
    if (command.name === 'cd') {
      const target = command.argv[1]
      if (target && target !== '-' && !target.startsWith('~')) dir = isAbsolute(target) ? target : resolve(dir, target)
      continue
    }
    if (command.name !== 'git') continue
    const parsed = parseGit(command.argv, dir)
    if (!parsed) continue
    const { sub, args, cwd } = parsed

    if ((sub === 'checkout' || sub === 'switch') && options.lockMainCheckout && switchesBranch(sub, args, cwd) && isMainWorktree(cwd))
      return {
        refusal: `trocar de branch na pasta principal do repositório troca o ambiente inteiro (o que roda e recarrega lê dela). Trabalhe numa worktree: git worktree add ../_worktrees/<nome> -b ${options.branchPrefix ?? ''}<nome>`,
        notes,
      }

    if (sub === 'push' && options.protectedBranches.length) {
      if (args.some((arg) => arg === '--all' || arg === '--mirror' || arg === '--branches'))
        return { refusal: `git push --all/--mirror com branches protegidas (${options.protectedBranches.join(', ')}): mande a branch do trabalho e abra um PR.`, notes }
      const targets = pushTargets(args, () => currentBranch(cwd))
      const hit = targets.find((target) => options.protectedBranches.includes(target))
      if (hit) return { refusal: `push direto em ${hit} é recusado nesta instalação (branch protegida): mande a sua branch e abra um PR.`, notes }
    }

    const created = newBranch(sub, args)
    if (created && options.branchPrefix && !created.startsWith(options.branchPrefix))
      notes.push(
        `⚠️ a branch ${created} está fora do prefixo desta instalação (${options.branchPrefix}): use ${options.branchPrefix}${created} para não colidir com outro gateway no mesmo remoto.`,
      )
  }
  return { notes }
}

/** As opções globais do git (antes do subcomando): `-C` muda a pasta; as outras com valor são puladas. */
const GLOBAL_WITH_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

function parseGit(argv: readonly string[], dir: string): { sub: string; args: string[]; cwd: string } | undefined {
  let cwd = dir
  let index = 1
  while (index < argv.length) {
    const arg = argv[index]!
    if (arg === '-C') {
      const path = argv[index + 1]
      if (path) cwd = isAbsolute(path) ? path : resolve(cwd, path)
      index += 2
      continue
    }
    if (GLOBAL_WITH_VALUE.has(arg)) {
      index += 2
      continue
    }
    if (arg.startsWith('-')) {
      index += 1
      continue
    }
    return { sub: arg, args: argv.slice(index + 1), cwd }
  }
  return undefined
}

/** O `checkout`/`switch` troca de branch? `--` ou caminho que existe = restaurar arquivo; `-b`, `--detach`, um nome = trocar. */
function switchesBranch(sub: string, args: readonly string[], cwd: string): boolean {
  if (args.includes('-h') || args.includes('--help')) return false
  if (sub === 'switch') return true
  if (args.includes('--') || args.includes('-p') || args.includes('--patch')) return false
  if (args.some((arg) => ['-b', '-B', '--orphan', '--detach'].includes(arg))) return true
  const names = args.filter((arg) => !arg.startsWith('-'))
  if (!names.length) return false
  // `git checkout arquivo.txt` (existe na pasta): restaura o arquivo.
  return !names.every((name) => existsSync(resolve(cwd, name)))
}

/** A pasta é a PRINCIPAL de um repositório (o `.git` mais próximo é diretório, não o arquivo de uma worktree)? */
function isMainWorktree(dir: string): boolean {
  let current = resolve(dir)
  for (;;) {
    const dotGit = join(current, '.git')
    try {
      return lstatSync(dotGit).isDirectory()
    } catch {
      const parent = dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
}

/** Os destinos de um `git push [opções] [remoto] [refspec…]`: o lado direito do refspec, ou a branch atual sem nenhum. */
function pushTargets(args: readonly string[], current: () => string | undefined): string[] {
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '-o' || arg === '--push-option' || arg === '--repo' || arg === '--receive-pack' || arg === '--exec') {
      index += 1
      continue
    }
    if (!arg.startsWith('-')) positional.push(arg)
  }
  const refspecs = positional.slice(1)
  if (!refspecs.length) {
    const branch = current()
    return branch ? [branch] : []
  }
  return refspecs.map((refspec) => {
    const spec = refspec.replace(/^\+/, '')
    const target = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec === 'HEAD' ? (current() ?? spec) : spec
    return target.replace(/^refs\/heads\//, '')
  })
}

/** A branch que o comando cria, quando cria: `checkout -b`, `switch -c`, `branch <nome>`, `worktree add -b`. */
function newBranch(sub: string, args: readonly string[]): string | undefined {
  const after = (flags: readonly string[]) => {
    const index = args.findIndex((arg) => flags.includes(arg))
    return index >= 0 ? args[index + 1] : undefined
  }
  if (sub === 'checkout') return after(['-b', '-B'])
  if (sub === 'switch') return after(['-c', '-C', '--create', '--force-create'])
  if (sub === 'worktree' && args[0] === 'add') return after(['-b', '-B'])
  if (sub === 'branch') {
    if (args.some((arg) => arg.startsWith('-'))) return undefined
    return args[0]
  }
  return undefined
}
