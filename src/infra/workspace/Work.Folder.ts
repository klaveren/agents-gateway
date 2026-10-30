import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** O nome de um repositório em `<projeto>/repositories/`: uma pasta só, sem barra. */
export const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/
/** O nome de uma worktree (a pasta dela) ou o branch: sem `..`, sem espaço. */
export const WORKTREE_NAME = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/

export const REPOSITORIES_DIR = 'repositories'

export class WorkFolderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkFolderError'
  }
}

/** Onde a conversa trabalha: a pasta, e o git dela quando é uma worktree (o diretório comum fica fora da pasta). */
export interface IWorkFolder {
  dir: string
  repository?: string
  worktree?: string
  /** A pasta do repositório (`<projeto>/repositories/<repo>`). */
  repositoryDir?: string
  /** O `.git` do repositório: dentro da pasta no modo só repositório; fora dela, na worktree. */
  gitCommonDir?: string
  /** O diretório git próprio da worktree (`<repo>/.git/worktrees/<nome>`). */
  worktreeGitDir?: string
}

export interface IWorktreeEntry {
  path: string
  branch?: string
  name: string
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** As worktrees de um repositório, pelo próprio git (qualquer layout: `_worktrees/EP-1`, `.worktrees/x`…). */
export function listWorktrees(repositoryDir: string): IWorktreeEntry[] {
  let out: string
  try {
    out = execFileSync('git', ['-C', repositoryDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return []
  }
  const entries: IWorktreeEntry[] = []
  for (const block of out.split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path) continue
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    entries.push({ path, ...(branch ? { branch } : {}), name: path.split(/[\\/]/).pop() ?? path })
  }
  // A primeira é o checkout principal: não é worktree.
  return entries.slice(1)
}

/** O `.git` de uma worktree é um arquivo: `gitdir: <repo>/.git/worktrees/<nome>`, e lá o `commondir` aponta o comum. */
function worktreeGit(dir: string): { gitDir: string; commonDir: string } | undefined {
  const dotGit = join(dir, '.git')
  if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return undefined
  const gitDir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
  if (!gitDir) return undefined
  const absoluteGitDir = real(resolve(dir, gitDir))
  const commonFile = join(absoluteGitDir, 'commondir')
  const commonDir = existsSync(commonFile) ? real(resolve(absoluteGitDir, readFileSync(commonFile, 'utf8').trim())) : absoluteGitDir
  return { gitDir: absoluteGitDir, commonDir }
}

/**
 * ⛔ A PASTA DE TRABALHO DE UMA CONVERSA: o projeto, um repositório dele (`<projeto>/repositories/<repo>`) ou uma
 * worktree desse repositório. Resolvida no servidor, depois do `realpath`: link ou worktree que leva para fora do
 * projeto é recusado. Quem cria e prepara a worktree é quem chama; aqui só se ativa o agente nela.
 */
export function resolveWorkFolder(projectDir: string, repository?: string, worktree?: string): IWorkFolder {
  const project = real(projectDir)
  if (!repository) {
    if (worktree) throw new WorkFolderError('worktree: informe também o repository')
    return { dir: project }
  }
  if (!REPOSITORY_NAME.test(repository) || repository === '.' || repository === '..') throw new WorkFolderError('repository: só o nome da pasta, sem barra')
  const repositoryDir = real(join(project, REPOSITORIES_DIR, repository))
  if (!inside(project, repositoryDir) || !existsSync(repositoryDir)) throw new WorkFolderError(`repository: ${repository} não existe em ${REPOSITORIES_DIR}/`)
  if (!existsSync(join(repositoryDir, '.git'))) throw new WorkFolderError(`repository: ${repository} não é um repositório git`)

  if (!worktree) {
    const dotGit = join(repositoryDir, '.git')
    const linked = worktreeGit(repositoryDir)
    return { dir: repositoryDir, repository, repositoryDir, gitCommonDir: linked?.commonDir ?? dotGit }
  }
  if (!WORKTREE_NAME.test(worktree)) throw new WorkFolderError('worktree: o nome da pasta da worktree ou o branch')
  const found = listWorktrees(repositoryDir).find((entry) => entry.name === worktree || entry.branch === worktree)
  if (!found) throw new WorkFolderError(`worktree: ${worktree} não é uma worktree de ${repository}`)
  const dir = real(found.path)
  if (!inside(project, dir)) throw new WorkFolderError(`worktree: ${worktree} fica fora do projeto`)
  const git = worktreeGit(dir)
  if (!git) throw new WorkFolderError(`worktree: ${worktree} não tem o .git de uma worktree`)
  return { dir, repository, worktree: found.name, repositoryDir, gitCommonDir: git.commonDir, worktreeGitDir: git.gitDir }
}

/** O branch em que a pasta está (para o contexto do agente). */
export function currentBranch(dir: string): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

/** Os repositórios do projeto e as worktrees de cada um, para a tela. */
export function listRepositories(projectDir: string): Array<{ name: string; worktrees: Array<{ name: string; branch?: string; path: string }> }> {
  const root = join(real(projectDir), REPOSITORIES_DIR)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && REPOSITORY_NAME.test(entry.name) && existsSync(join(root, entry.name, '.git')))
    .map((entry) => {
      const repositoryDir = join(root, entry.name)
      return {
        name: entry.name,
        worktrees: listWorktrees(repositoryDir)
          .filter((item) => inside(real(projectDir), real(item.path)))
          .map((item) => ({ name: item.name, ...(item.branch ? { branch: item.branch } : {}), path: relative(real(projectDir), real(item.path)).split(sep).join('/') })),
      }
    })
}
