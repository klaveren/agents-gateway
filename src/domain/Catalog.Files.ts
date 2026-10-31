import { canonicalize, catalogHash, CATALOG_KINDS, ICatalogDocument, protocolItemId, TCanonicalBody, TCanonicalValue, TCatalogKind } from './Catalog.Document'
import { FrontmatterError, parseFrontmatter, stringifyFrontmatter } from './Frontmatter.Codec'
import type { IMaskHit } from './Secret.Mask'
import { PROJECT_ID_PATTERN } from './models/Project.Model'
import { PROTOCOL_KINDS, TProtocolKind } from './models/Protocol.Model'

/**
 * O MAPEAMENTO DOCUMENTO ↔ ARQUIVOS do pacote do catálogo (docs/integration/plano-catalogo-historico.md §2.5, PR 7).
 *
 * ```
 * catalog.json                         # o manifesto (só ele muda a cada export)
 * global/                              # ou projects/<projectId>/, com project.json e permissions.json
 *   rules/<slug-do-titulo>.md          # frontmatter: id, title, position, enabled
 *   specs/<id>.md  adrs/<id>.md  knowledge/<id>.md   # frontmatter: id, title, summary, docs, docRefs
 *   skills/<id>/SKILL.md               # frontmatter: name (o id), description, docs, docRefs
 *   commands/<id>.md                   # frontmatter: description, docs, docRefs (o id é o nome do arquivo)
 *   protocols/<tipo>.md                # frontmatter: kind
 *   agents/<id>/agent.json             # tudo menos soul e prompt
 *   agents/<id>/soul.md  agents/<id>/prompt.md
 *   mcps/<id>.json                     # sem segredo: os nomes das variáveis e `secrets`
 * ```
 *
 * ⚖️ TEXTO em `.md` (o corpo é o `body`, o resto vai no frontmatter); ESTRUTURA em JSON canônico. O `projectId` é a
 * pasta, nunca um campo do frontmatter. A ida e a volta são exatas: `documentsFromFiles(catalogFiles(docs))` devolve os
 * mesmos documentos, com o mesmo hash — é o que o import (PRs 8 e 9) usa pelo `parsePackage`.
 */

/** Caminho relativo (com `/`) → conteúdo, UTF-8 e LF. */
export type TCatalogFiles = Record<string, string>

export const MANIFEST_PATH = 'catalog.json'
export const CATALOG_FORMAT = 1

/** O que a máscara trocou: onde, e de que jeito — ⛔ nunca o valor. */
export interface ICatalogMasked {
  path: string
  kind: TCatalogKind
  id: string
  projectId?: string
  /** O campo do documento: `body`, `env.GH_TOKEN`, `process.args[2]`… */
  field: string
  layer: IMaskHit['layer']
  label: string
}

export interface ICatalogManifest {
  format: typeof CATALOG_FORMAT
  /** `all`, `global` ou `project:<id>`. */
  scope: string
  gateway?: string
  exportedAt: string
  exportedBy?: string
  /** Cada arquivo do pacote (menos o próprio manifesto) → sha256 do conteúdo. */
  files: Record<string, string>
  masked: ICatalogMasked[]
}

/** Um documento e os arquivos dele (o agente tem até três; os outros, um). */
export interface ICatalogEntry {
  document: ICatalogDocument
  files: TCatalogFiles
}

export interface ICatalogFilesError {
  path: string
  message: string
}

type TTextKind = 'skill' | 'command' | 'rule' | 'spec' | 'adr' | 'knowledge' | 'protocol'

interface ITextLayout {
  dir: string
  /** Campo do documento → chave do frontmatter. */
  rename: Readonly<Record<string, string>>
  /** O id vai no frontmatter (`false`: só no nome do arquivo). */
  idInData: boolean
}

const TEXT: Readonly<Record<TTextKind, ITextLayout>> = {
  skill: { dir: 'skills', rename: { id: 'name', docIds: 'docs' }, idInData: true },
  command: { dir: 'commands', rename: { docIds: 'docs' }, idInData: false },
  rule: { dir: 'rules', rename: {}, idInData: true },
  spec: { dir: 'specs', rename: { docIds: 'docs' }, idInData: true },
  adr: { dir: 'adrs', rename: { docIds: 'docs' }, idInData: true },
  knowledge: { dir: 'knowledge', rename: { docIds: 'docs' }, idInData: true },
  protocol: { dir: 'protocols', rename: {}, idInData: false },
}

const AGENT_DIR = 'agents'
const MCP_DIR = 'mcps'
const AGENT_JSON = 'agent.json'
const SOUL = 'soul.md'
const PROMPT = 'prompt.md'
const SKILL_FILE = 'SKILL.md'
const PROJECT_JSON = 'project.json'
const PERMISSIONS_JSON = 'permissions.json'
/** Um pedaço de caminho seguro: nada de `..`, barra, espaço ou maiúscula surpresa. */
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/

const isText = (kind: TCatalogKind): kind is TTextKind => kind in TEXT
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const rootOf = (projectId: string | undefined) => (projectId ? `projects/${projectId}` : 'global')
const json = (body: TCanonicalBody) => canonicalize(body)

/** O título em slug ASCII (sem acento), para o nome do arquivo da rule. */
export function slugOf(title: string, max = 60): string {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
  return slug || 'rule'
}

function textFile(document: ICatalogDocument): string {
  const layout = TEXT[document.kind as TTextKind]
  const data: TCanonicalBody = {}
  for (const [key, value] of Object.entries(document.body)) {
    if (key === 'body' || key === 'projectId' || (key === 'id' && !layout.idInData)) continue
    data[layout.rename[key] ?? key] = value
  }
  const body = document.body.body
  if (typeof body !== 'string') throw new TypeError(`catalog files: ${document.kind}/${document.id} sem corpo`)
  return stringifyFrontmatter({ data, body })
}

/**
 * Os arquivos de cada documento, na ordem recebida. O nome da rule é o slug do título; dois títulos com o mesmo slug no
 * mesmo escopo: a que vem antes (posição, depois id) fica com o slug, a outra ganha o id no fim.
 */
export function catalogFiles(documents: readonly ICatalogDocument[]): ICatalogEntry[] {
  const rulePaths = new Map<ICatalogDocument, string>()
  const rules = documents.filter((document) => document.kind === 'rule').sort((a, b) => Number(a.body.position) - Number(b.body.position) || byText(a.id, b.id))
  const taken = new Set<string>()
  for (const rule of rules) {
    const dir = `${rootOf(rule.projectId)}/${TEXT.rule.dir}`
    const slug = slugOf(String(rule.body.title ?? ''))
    let path = `${dir}/${slug}.md`
    if (taken.has(path)) path = `${dir}/${slug}-${slugOf(rule.id, 80)}.md`
    taken.add(path)
    rulePaths.set(rule, path)
  }

  return documents.map((document) => {
    const root = rootOf(document.projectId)
    const { kind, id, body } = document
    const files: TCatalogFiles = {}
    if (kind === 'project') files[`${root}/${PROJECT_JSON}`] = json(body)
    else if (kind === 'project-permissions') files[`${root}/${PERMISSIONS_JSON}`] = json(body)
    else if (kind === 'mcp') files[`${root}/${MCP_DIR}/${id}.json`] = json(body)
    else if (kind === 'agent') {
      const { soul, systemPrompt, ...rest } = body
      files[`${root}/${AGENT_DIR}/${id}/${AGENT_JSON}`] = json(rest)
      if (soul !== undefined) files[`${root}/${AGENT_DIR}/${id}/${SOUL}`] = String(soul)
      if (systemPrompt !== undefined) files[`${root}/${AGENT_DIR}/${id}/${PROMPT}`] = String(systemPrompt)
    } else if (isText(kind)) {
      const layout = TEXT[kind]
      const name = kind === 'rule' ? rulePaths.get(document)! : kind === 'skill' ? `${root}/${layout.dir}/${id}/${SKILL_FILE}` : `${root}/${layout.dir}/${fileIdOf(document)}.md`
      files[name] = textFile(document)
    }
    return { document, files }
  })
}

/** O nome do arquivo do texto: o id, ou o tipo do complemento de protocolo. */
function fileIdOf(document: ICatalogDocument): string {
  return document.kind === 'protocol' ? String(document.body.kind) : document.id
}

/** O arquivo onde mora um campo do documento (o agente separa `soul` e `systemPrompt`). */
export function fileOfField(entry: ICatalogEntry, field: string): string {
  const paths = Object.keys(entry.files)
  if (entry.document.kind === 'agent') {
    const top = field.split(/[.[]/)[0]
    const suffix = top === 'soul' ? `/${SOUL}` : top === 'systemPrompt' ? `/${PROMPT}` : `/${AGENT_JSON}`
    return paths.find((path) => path.endsWith(suffix)) ?? paths[0]
  }
  return paths[0]
}

/** O conjunto de arquivos do pacote: os de cada documento juntos. ⛔ Caminho repetido é erro de quem montou. */
export function flattenFiles(entries: readonly ICatalogEntry[]): TCatalogFiles {
  const files: TCatalogFiles = {}
  for (const entry of entries) {
    for (const [path, content] of Object.entries(entry.files)) {
      if (path in files) throw new Error(`catalog files: caminho repetido ${path}`)
      files[path] = content
    }
  }
  return files
}

export function fileHash(content: string): string {
  return catalogHash(content)
}

/** O manifesto como texto: chaves em ordem, indentação de 2, LF. */
export function manifestText(manifest: ICatalogManifest): string {
  return canonicalize(manifest as unknown as TCanonicalBody)
}

// --- A volta: arquivos → documentos --------------------------------------------------------------------------------

function documentOf(kind: TCatalogKind, id: string, projectId: string | undefined, body: TCanonicalBody): ICatalogDocument {
  const text = canonicalize(body)
  return { kind, id, ...(projectId ? { projectId } : {}), body, text, hash: catalogHash(text) }
}

class FilesError extends Error {}

function parseJson(path: string, content: string): TCanonicalBody {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new FilesError('JSON inválido')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FilesError('esperado um objeto JSON')
  if (!isCanonicalTree(value)) throw new FilesError(`valor fora do documento canônico (null?) em ${path}`)
  return value as TCanonicalBody
}

function isCanonicalTree(value: unknown): value is TCanonicalValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isCanonicalTree)
  if (value && typeof value === 'object') return Object.values(value).every(isCanonicalTree)
  return false
}

function textDocument(kind: TTextKind, fileId: string, projectId: string | undefined, content: string): ICatalogDocument {
  const layout = TEXT[kind]
  const { data, body: markdown } = parseFrontmatter(content)
  const inverse = Object.fromEntries(Object.entries(layout.rename).map(([field, key]) => [key, field]))
  const body: TCanonicalBody = {}
  for (const [key, value] of Object.entries(data)) {
    if (key === 'body' || key === 'projectId') throw new FilesError(`\`${key}\` não vai no frontmatter (vem do corpo e da pasta)`)
    if (!layout.idInData && key === 'id') throw new FilesError('`id` não vai no frontmatter (é o nome do arquivo)')
    const field = inverse[key] ?? key
    if (field in body) throw new FilesError(`campo repetido: ${key}`)
    body[field] = value
  }
  if (projectId) body.projectId = projectId
  body.body = markdown

  if (kind === 'protocol') {
    if (!PROTOCOL_KINDS.includes(fileId as TProtocolKind)) throw new FilesError(`tipo de protocolo desconhecido: ${fileId}`)
    if (body.kind !== fileId) throw new FilesError(`\`kind\` (${String(body.kind)}) difere do arquivo (${fileId})`)
    return documentOf('protocol', protocolItemId(fileId as TProtocolKind, projectId), projectId, body)
  }
  if (!layout.idInData) body.id = fileId
  else if (kind !== 'rule' && body.id !== fileId) throw new FilesError(`o id do frontmatter (${String(body.id)}) difere do arquivo (${fileId})`)
  if (typeof body.id !== 'string' || !body.id) throw new FilesError('sem id')
  return documentOf(kind, body.id, projectId, body)
}

/**
 * Os documentos de volta a partir dos arquivos (o `parsePackage` do import). O manifesto fica de fora (é metadado do
 * pacote); arquivo fora do formato vira erro com o caminho, e os outros seguem. Na ordem do catálogo (tipo, depois id).
 */
export function documentsFromFiles(files: TCatalogFiles): { documents: ICatalogDocument[]; errors: ICatalogFilesError[] } {
  const documents: ICatalogDocument[] = []
  const errors: ICatalogFilesError[] = []
  const agents = new Map<string, { projectId?: string; id: string; json?: [string, string]; soul?: string; prompt?: string }>()

  for (const path of Object.keys(files).sort(byText)) {
    if (path === MANIFEST_PATH) continue
    const content = files[path]
    try {
      const parts = path.split('/')
      if (parts.some((part) => !part || part === '.' || part === '..')) throw new FilesError('caminho inválido')
      let projectId: string | undefined
      let rest: string[]
      if (parts[0] === 'global') rest = parts.slice(1)
      else if (parts[0] === 'projects' && parts.length > 2 && PROJECT_ID_PATTERN.test(parts[1])) {
        projectId = parts[1]
        rest = parts.slice(2)
      } else throw new FilesError('fora de `global/` e de `projects/<id>/`')

      const [dir, name, leaf] = rest
      if (projectId && rest.length === 1 && dir === PROJECT_JSON) {
        const body = parseJson(path, content)
        if (body.id !== projectId) throw new FilesError(`o id (${String(body.id)}) difere da pasta (${projectId})`)
        documents.push(documentOf('project', projectId, projectId, body))
      } else if (projectId && rest.length === 1 && dir === PERMISSIONS_JSON) {
        const body = parseJson(path, content)
        if (body.projectId !== projectId) throw new FilesError(`o projectId (${String(body.projectId)}) difere da pasta (${projectId})`)
        documents.push(documentOf('project-permissions', projectId, projectId, body))
      } else if (dir === MCP_DIR && rest.length === 2 && name.endsWith('.json') && SEGMENT.test(name)) {
        const id = name.slice(0, -'.json'.length)
        const body = parseJson(path, content)
        if (body.id !== id) throw new FilesError(`o id (${String(body.id)}) difere do arquivo (${id})`)
        if ((body.projectId ?? undefined) !== projectId) throw new FilesError('o projectId difere da pasta')
        documents.push(documentOf('mcp', id, projectId, body))
      } else if (dir === AGENT_DIR && rest.length === 3 && SEGMENT.test(name) && [AGENT_JSON, SOUL, PROMPT].includes(leaf)) {
        const key = `${projectId ?? ''}/${name}`
        const agent = agents.get(key) ?? { id: name, ...(projectId ? { projectId } : {}) }
        if (leaf === AGENT_JSON) agent.json = [path, content]
        else if (leaf === SOUL) agent.soul = content
        else agent.prompt = content
        agents.set(key, agent)
      } else if (dir === TEXT.skill.dir && rest.length === 3 && SEGMENT.test(name) && leaf === SKILL_FILE) {
        documents.push(textDocument('skill', name, projectId, content))
      } else {
        const kind = (Object.keys(TEXT) as TTextKind[]).find((item) => TEXT[item].dir === dir && item !== 'skill')
        if (!kind || rest.length !== 2 || !name.endsWith('.md') || !SEGMENT.test(name)) throw new FilesError('arquivo fora do formato do pacote')
        documents.push(textDocument(kind, name.slice(0, -'.md'.length), projectId, content))
      }
    } catch (error) {
      if (!(error instanceof FilesError) && !(error instanceof FrontmatterError)) throw error
      errors.push({ path, message: error.message })
    }
  }

  for (const agent of agents.values()) {
    const path = agent.json?.[0] ?? `${rootOf(agent.projectId)}/${AGENT_DIR}/${agent.id}/${AGENT_JSON}`
    try {
      if (!agent.json) throw new FilesError(`falta o ${AGENT_JSON}`)
      const body = parseJson(path, agent.json[1])
      if (body.id !== agent.id) throw new FilesError(`o id (${String(body.id)}) difere da pasta (${agent.id})`)
      if ((body.projectId ?? undefined) !== agent.projectId) throw new FilesError('o projectId difere da pasta')
      if ('soul' in body || 'systemPrompt' in body) throw new FilesError(`soul e prompt vão em ${SOUL} e ${PROMPT}`)
      if (agent.soul !== undefined) body.soul = agent.soul
      if (agent.prompt !== undefined) body.systemPrompt = agent.prompt
      documents.push(documentOf('agent', agent.id, agent.projectId, body))
    } catch (error) {
      if (!(error instanceof FilesError)) throw error
      errors.push({ path, message: error.message })
    }
  }

  const order = (kind: TCatalogKind) => CATALOG_KINDS.indexOf(kind)
  documents.sort((a, b) => order(a.kind) - order(b.kind) || byText(a.id, b.id) || byText(a.projectId ?? '', b.projectId ?? ''))
  return { documents, errors }
}
