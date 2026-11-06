import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { FILE_DIRS, filePathIssue, IResourceFile, RESOURCE_FILE_MAX_BYTES, RESOURCE_FILES_MAX_COUNT, TFileOwnerKind } from '@domain/models/ResourceFile.Model'
import { IResourceFilesPort } from '@domain/ports/ResourceFiles.Port'
import { dataDir, projectWorkspacePath } from '@infra/adapters/support/Subscription.Workspace'

/** A pasta global dos arquivos de recurso: `<dados>/global`. */
export function globalResourcesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'global')
}

/** As pastas de arquivos de recurso de um projeto (`skills/`, `commands/`, `agents/` na pasta dele). */
export function projectResourceDirs(projectId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const project = projectWorkspacePath(projectId, env)
  return Object.values(FILE_DIRS).map((dir) => join(project, dir))
}

/** As pastas de recurso que se leem e nunca se gravam: as de skills e commands. A de agentes é de cada agente (`agentFolders`). */
const SHARED_KINDS = (Object.keys(FILE_DIRS) as TFileOwnerKind[]).filter((kind) => kind !== 'agent')

/** O projeto da raiz (a pasta dele ou uma dentro dele, como uma worktree), na mesma forma do caminho da raiz. */
function projectOfRoot(root: string, env: NodeJS.ProcessEnv): { base: string; id: string } | undefined {
  const target = resolve(root) + sep
  const data = dataDir(env)
  // A raiz pode vir pelo caminho real (no Mac, `/var` é `/private/var`): a pasta do projeto sai na mesma forma que ela.
  const projects = [data, realOrSelf(data)].map((base) => join(base, 'projects') + sep).find((dir) => target.startsWith(dir))
  const id = projects ? target.slice(projects.length).split(sep)[0] : undefined
  return projects && id ? { base: join(projects, id), id } : undefined
}

/**
 * As pastas SÓ LEITURA de quem trabalha na `root`: as de skills e commands globais sempre; as do projeto quando a raiz é
 * o projeto (ou uma pasta dentro dele, como uma worktree). O cerco as libera para ler e nega a escrita. ⛔ As pastas de
 * agentes não entram: cada uma é privada do seu agente (`agentFolders`).
 */
export function readOnlyResourceDirs(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const project = projectOfRoot(root, env)
  return [...SHARED_KINDS.map((kind) => join(globalResourcesDir(env), FILE_DIRS[kind])), ...(project ? SHARED_KINDS.map((kind) => join(project.base, FILE_DIRS[kind])) : [])]
}

/**
 * ⛔ A PASTA PRIVADA de cada agente: a dele (`own`, se há agente) e as dos OUTROS que quem trabalha na `root` alcançaria
 * (as globais e as do projeto da raiz). As dos outros ficam fechadas para ler e gravar, com regra ou sem.
 */
export function agentFolders(root: string, own: string | undefined, env: NodeJS.ProcessEnv = process.env): { others: string[] } {
  const project = projectOfRoot(root, env)
  const parents = [join(globalResourcesDir(env), FILE_DIRS.agent), ...(project ? [join(project.base, FILE_DIRS.agent)] : [])]
  const mine = own ? resolve(own) : undefined
  const others = parents.flatMap((parent) => {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => join(parent, entry.name))
    } catch {
      return []
    }
  })
  return { others: others.filter((dir) => !mine || (resolve(dir) !== mine && realOrSelf(dir) !== realOrSelf(mine))) }
}

/** O agente dono da pasta de agente onde o caminho mora (`global/agents/<id>/…`, `projects/<p>/agents/<id>/…`), ou nada. */
export function agentFolderOwner(absPath: string, env: NodeJS.ProcessEnv = process.env): { agentId: string; dir: string } | undefined {
  const target = resolve(absPath)
  const data = dataDir(env)
  for (const base of new Set([data, realOrSelf(data)])) {
    const global = join(base, 'global', FILE_DIRS.agent) + sep
    if (target.startsWith(global)) {
      const id = target.slice(global.length).split(sep)[0]
      if (id) return { agentId: id, dir: join(global, id) }
    }
    const projects = join(base, 'projects') + sep
    if (!target.startsWith(projects)) continue
    const [project, folder, id] = target.slice(projects.length).split(sep)
    if (project && folder === FILE_DIRS.agent && id) return { agentId: id, dir: join(projects, project, folder, id) }
  }
  return undefined
}

/**
 * ⛔ O caminho é de uma pasta de arquivos de recurso que o agente só lê (skills, commands; quem grava é o gateway)? A
 * pasta de um agente não conta: é dele (`agentFolderOwner`), e a de outro é recusada à parte.
 */
export function isResourceFilePath(absPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = resolve(absPath)
  if (agentFolderOwner(target, env)) return false
  // Os dados pelo caminho dado e pelo real (no Mac, `/var` é `/private/var`): o alvo pode vir de um ou de outro.
  const data = dataDir(env)
  return [data, realOrSelf(data)].some((base) => {
    const inside = (dir: string) => target === dir || target.startsWith(dir + sep)
    if (inside(join(base, 'global'))) return true
    const projects = join(base, 'projects') + sep
    if (!target.startsWith(projects)) return false
    const [, folder] = target.slice(projects.length).split(sep)
    return Object.values(FILE_DIRS).includes(folder ?? '')
  })
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * O DEPÓSITO por sha256 (`<dados>/files/blobs/ab/abcd…`) e a escrita das pastas. A pasta é trocada INTEIRA de uma vez
 * (monta ao lado e renomeia): quem lê no meio vê a de antes ou a nova, nunca metade.
 */
export class ResourceFilesStore implements IResourceFilesPort {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private blob(sha256: string): string {
    return join(dataDir(this.env), 'files', 'blobs', sha256.slice(0, 2), sha256)
  }

  has(sha256: string): boolean {
    return /^[a-f0-9]{64}$/.test(sha256) && existsSync(this.blob(sha256))
  }

  put(content: Buffer): { sha256: string; bytes: number } {
    const sha256 = createHash('sha256').update(content).digest('hex')
    const target = this.blob(sha256)
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
      writeFileSync(temp, content, { mode: 0o600 })
      renameSync(temp, target)
    }
    return { sha256, bytes: content.length }
  }

  read(sha256: string): Buffer | undefined {
    return this.has(sha256) ? readFileSync(this.blob(sha256)) : undefined
  }

  dirOf(kind: TFileOwnerKind, id: string, projectId?: string): string {
    const base = projectId ? projectWorkspacePath(projectId, this.env) : globalResourcesDir(this.env)
    return join(base, FILE_DIRS[kind], id)
  }

  sync(kind: TFileOwnerKind, id: string, projectId: string | undefined, files: readonly IResourceFile[]): void {
    const dir = this.dirOf(kind, id, projectId)
    if (!files.length) return this.remove(kind, id, projectId)
    const temp = join(dirname(dir), `.${id}.${randomBytes(6).toString('hex')}.tmp`)
    mkdirSync(temp, { recursive: true, mode: 0o755 })
    try {
      for (const file of files) {
        if (filePathIssue(file.path)) throw new Error(`invalid resource file path: ${file.path}`)
        const content = this.read(file.sha256)
        if (!content) throw new Error(`resource file content not found: ${file.path} (${file.sha256})`)
        const target = join(temp, ...file.path.split('/'))
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
        writeFileSync(target, content)
        // Script com `#!` roda direto; o resto só se lê.
        chmodSync(target, content.subarray(0, 2).toString() === '#!' ? 0o755 : 0o644)
      }
      const old = existsSync(dir) ? `${temp}.old` : undefined
      if (old) renameSync(dir, old)
      renameSync(temp, dir)
      if (old) rmSync(old, { recursive: true, force: true })
    } catch (error) {
      rmSync(temp, { recursive: true, force: true })
      throw error
    }
  }

  remove(kind: TFileOwnerKind, id: string, projectId?: string): void {
    rmSync(this.dirOf(kind, id, projectId), { recursive: true, force: true })
  }

  writeAgent(id: string, projectId: string | undefined, files: readonly IResourceFile[], removed: readonly string[]): void {
    const dir = this.dirOf('agent', id, projectId)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    for (const file of files) {
      if (filePathIssue(file.path)) throw new Error(`invalid resource file path: ${file.path}`)
      const target = join(dir, ...file.path.split('/'))
      if (shaOf(target) === file.sha256) continue
      const content = this.read(file.sha256)
      if (!content) throw new Error(`resource file content not found: ${file.path} (${file.sha256})`)
      writeAtomically(target, content)
    }
    const kept = new Set(files.map((file) => file.path))
    for (const path of removed) {
      if (kept.has(path) || filePathIssue(path)) continue
      const target = join(dir, ...path.split('/'))
      try {
        if (lstatSync(target).isFile()) unlinkSync(target)
      } catch {
        // Já não estava lá.
      }
      pruneEmpty(dirname(target), dir)
    }
  }

  restoreAgent(id: string, projectId: string | undefined, files: readonly IResourceFile[]): void {
    const dir = this.dirOf('agent', id, projectId)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    for (const file of files) {
      if (filePathIssue(file.path)) continue
      const target = join(dir, ...file.path.split('/'))
      if (existsSync(target)) continue
      const content = this.read(file.sha256)
      if (content) writeAtomically(target, content)
    }
  }

  moveAgent(id: string, from: string | undefined, to: string | undefined): void {
    const source = this.dirOf('agent', id, from)
    const target = this.dirOf('agent', id, to)
    if (source === target || !existsSync(source)) return
    // Lá já havia uma pasta: a do agente não passa por cima dela (fica onde está, e a gravação seguinte escreve a lista).
    if (existsSync(target)) return
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
    renameSync(source, target)
  }

  snapshotAgent(id: string, projectId: string | undefined): IResourceFile[] {
    const dir = this.dirOf('agent', id, projectId)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const found: IResourceFile[] = []
    const visit = (rel: string) => {
      let entries
      try {
        entries = readdirSync(join(dir, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (found.length >= RESOURCE_FILES_MAX_COUNT) return
        const path = rel ? `${rel}/${entry.name}` : entry.name
        // ⚖️ Só o que a lista aceita (o nome, o tamanho): o resto fica na pasta, fora da tela. Link não se segue.
        if (filePathIssue(path)) continue
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile()) {
          const content = readFileSync(join(dir, path))
          if (content.length > RESOURCE_FILE_MAX_BYTES || content.subarray(0, 8000).includes(0)) continue
          found.push({ path, ...this.put(content) })
        }
      }
    }
    visit('')
    return found
  }
}

/** O sha256 do arquivo no disco, ou nada (não existe, não é arquivo). */
function shaOf(path: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

/** Grava ao lado e renomeia: quem lê no meio vê o de antes ou o novo. Script com `#!` roda direto. */
function writeAtomically(target: string, content: Buffer): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, content, { mode: content.subarray(0, 2).toString() === '#!' ? 0o755 : 0o644 })
  renameSync(temp, target)
}

/** Tira as pastas que ficaram vazias, subindo até a pasta do agente (ela fica). */
function pruneEmpty(dir: string, stop: string): void {
  let current = dir
  while (current !== stop && current.startsWith(stop + sep)) {
    try {
      if (readdirSync(current).length) return
      rmdirSync(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}
