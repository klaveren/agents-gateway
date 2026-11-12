import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { IGitPlace, safeGitSync } from './Git.Safe'

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

/**
 * ⛔ O `.git` do repositório, calculado aqui: tem de ser um DIRETÓRIO de verdade (não link, não o arquivo `gitdir:` que o
 * agente reescreve) e ficar dentro do repositório.
 */
function repositoryGit(repositoryDir: string): string | undefined {
  const dotGit = join(repositoryDir, '.git')
  try {
    if (!lstatSync(dotGit).isDirectory()) return undefined
    const commonDir = realpathSync(dotGit)
    return commonDir === join(real(repositoryDir), '.git') ? commonDir : undefined
  } catch {
    return undefined
  }
}

/** As worktrees de um repositório, pelo próprio git (qualquer layout: `_worktrees/EP-1`, `.worktrees/x`…). */
export function listWorktrees(repositoryDir: string): IWorktreeEntry[] {
  const gitCommonDir = repositoryGit(repositoryDir)
  if (!gitCommonDir) return []
  const out = safeGitSync({ dir: repositoryDir, gitCommonDir }, ['worktree', 'list', '--porcelain'], { timeout: 10_000 })
  if (out === undefined) return []
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

/**
 * ⛔ O git de uma worktree, CONFERIDO. O `.git` dela é um arquivo que o agente reescreve (`gitdir: <onde>`), e o
 * `commondir` lá dentro também: nenhum dos dois vale como veio. O comum é o `.git` do repositório (`commonDir`, já
 * calculado), e o da worktree TEM de ser `<comum>/worktrees/<nome>` e apontar de volta para esta pasta.
 */
function worktreeGit(dir: string, commonDir: string): { gitDir: string; commonDir: string } | undefined {
  const dotGit = join(dir, '.git')
  try {
    if (!lstatSync(dotGit).isFile()) return undefined
    const gitDir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
    if (!gitDir) return undefined
    const absoluteGitDir = realpathSync(resolve(dir, gitDir))
    if (dirname(absoluteGitDir) !== join(commonDir, 'worktrees')) return undefined
    // O caminho de volta, que o git grava ao criar a worktree: outra worktree do mesmo repositório não serve.
    const back = readFileSync(join(absoluteGitDir, 'gitdir'), 'utf8').trim()
    if (realpathSync(resolve(absoluteGitDir, back)) !== join(realpathSync(dir), '.git')) return undefined
    return { gitDir: absoluteGitDir, commonDir }
  } catch {
    return undefined
  }
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
  // ⛔ O git calculado aqui, nunca lido do que o agente grava: o `.git` do repositório é um diretório dele mesmo.
  const gitCommonDir = repositoryGit(repositoryDir)
  if (!gitCommonDir) throw new WorkFolderError(`repository: ${repository} não é um repositório git`)

  if (!worktree) return { dir: repositoryDir, repository, repositoryDir, gitCommonDir }
  if (!WORKTREE_NAME.test(worktree)) throw new WorkFolderError('worktree: o nome da pasta da worktree ou o branch')
  const found = listWorktrees(repositoryDir).find((entry) => entry.name === worktree || entry.branch === worktree)
  if (!found) throw new WorkFolderError(`worktree: ${worktree} não é uma worktree de ${repository}`)
  const dir = real(found.path)
  if (!inside(project, dir)) throw new WorkFolderError(`worktree: ${worktree} fica fora do projeto`)
  const git = worktreeGit(dir, gitCommonDir)
  if (!git) throw new WorkFolderError(`worktree: ${worktree} não tem o .git de uma worktree deste repositório`)
  return { dir, repository, worktree: found.name, repositoryDir, gitCommonDir: git.commonDir, worktreeGitDir: git.gitDir }
}

/** O branch em que a pasta está (para o contexto do agente), pelo git calculado pelo servidor. */
export function currentBranch(place: IGitPlace): string | undefined {
  return safeGitSync(place, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })?.trim() || undefined
}

/**
 * As pastas das worktrees de um repositório que ficam no projeto e são DELE — o `.git` de cada uma conferido
 * (`worktreeGit`): o que se apaga junto com o repositório.
 */
export function worktreeFolders(projectDir: string, repository: string): string[] {
  const project = real(projectDir)
  const repositoryDir = real(join(project, REPOSITORIES_DIR, repository))
  const gitCommonDir = repositoryGit(repositoryDir)
  if (!gitCommonDir) return []
  return listWorktrees(repositoryDir)
    .map((entry) => real(entry.path))
    .filter((dir) => dir !== project && inside(project, dir) && worktreeGit(dir, gitCommonDir) !== undefined)
}

/** A origem (`remote.origin.url`) para a tela: sem usuário nem senha, caso a URL os traga. Ausente = repositório local. */
function originOf(place: IGitPlace): string | undefined {
  const raw = safeGitSync(place, ['config', '--get', 'remote.origin.url'], { timeout: 5000 })?.trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 300)
  } catch {
    // `git@servidor:grupo/app.git` não é URL: vai como está.
    return raw.slice(0, 300)
  }
}

export interface IRepositoryEntry {
  name: string
  /** A branch da pasta principal. */
  branch?: string
  /** De onde veio; ausente = local, sem remoto. */
  origin?: string
  worktrees: Array<{ name: string; branch?: string; path: string }>
}

/** Os repositórios do projeto (a pasta com o `.git` dela) e as worktrees de cada um, para a tela. */
export function listRepositories(projectDir: string): IRepositoryEntry[] {
  const project = real(projectDir)
  const root = join(project, REPOSITORIES_DIR)
  if (!existsSync(root)) return []
  const entries: IRepositoryEntry[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !REPOSITORY_NAME.test(entry.name)) continue
    const repositoryDir = join(root, entry.name)
    // A worktree criada ao lado (`repositories/EP-1`, com o `.git` em arquivo) não é repositório.
    const gitCommonDir = repositoryGit(repositoryDir)
    if (!gitCommonDir) continue
    const place = { dir: repositoryDir, gitCommonDir }
    const branch = currentBranch(place)
    const origin = originOf(place)
    entries.push({
      name: entry.name,
      ...(branch && branch !== 'HEAD' ? { branch } : {}),
      ...(origin ? { origin } : {}),
      worktrees: listWorktrees(repositoryDir)
        .filter((item) => inside(project, real(item.path)))
        .map((item) => ({ name: item.name, ...(item.branch ? { branch: item.branch } : {}), path: relative(project, real(item.path)).split(sep).join('/') })),
    })
  }
  return entries
}

/**
 * O caminho do arquivo também a partir da pasta do PROJETO, quando a conversa trabalha numa worktree ou num repositório
 * (ver `IPermissionSubject.aliases`): as regras do projeto costumam ser escritas de lá (`repositories/x/_worktrees/*\/**`).
 * Fora da pasta do projeto, ou com a mesma pasta, nada.
 */
export function projectAliases(abs: string, folder: { dir: string; projectDir: string } | undefined): string[] {
  if (!folder) return []
  const project = real(folder.projectDir)
  if (project === real(folder.dir)) return []
  // O arquivo a criar ainda não existe: vale a pasta dele, canônica, mais o nome.
  const canonical = existsSync(abs) ? real(abs) : join(real(dirname(abs)), basename(abs))
  const rel = relative(project, canonical)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? [rel.split(sep).join('/')] : []
}
