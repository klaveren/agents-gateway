import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { FILE_DIRS, filePathIssue, IResourceFile, TFileOwnerKind } from '@domain/models/ResourceFile.Model'
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

/**
 * As pastas SÓ LEITURA de quem trabalha na `root`: a global sempre; as do projeto quando a raiz é o projeto (ou uma
 * pasta dentro dele, como uma worktree). O cerco as libera para ler e nega a escrita.
 */
export function readOnlyResourceDirs(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const target = resolve(root) + sep
  const data = dataDir(env)
  // A raiz pode vir pelo caminho real (no Mac, `/var` é `/private/var`): a pasta do projeto sai na mesma forma que ela.
  const projects = [data, realOrSelf(data)].map((base) => join(base, 'projects') + sep).find((dir) => target.startsWith(dir))
  const project = projects ? target.slice(projects.length).split(sep)[0] : undefined
  return [globalResourcesDir(env), ...(projects && project ? Object.values(FILE_DIRS).map((dir) => join(projects, project, dir)) : [])]
}

/** ⛔ O caminho é de uma pasta de arquivos de recurso (o agente só lê; quem grava é o gateway)? */
export function isResourceFilePath(absPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = resolve(absPath)
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
}
