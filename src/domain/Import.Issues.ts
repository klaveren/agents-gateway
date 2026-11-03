import { ICatalogDocument, TCanonicalBody, TCanonicalValue } from './Catalog.Document'
import { withBody } from './Catalog.Import'
import { IImportProblem, problemList, RESTORABLE_CODES, TImportProblemLink } from './models/ImportProblem.Model'
import { ALL_RESOURCES } from './models/Resource.Model'

/**
 * OS VÍNCULOS DA IMPORTAÇÃO QUE NÃO BLOQUEIAM (puro). O rascunho aprovado cita, pelo `linkCitation`, o que achou no
 * texto; o que não vira vínculo válido no catálogo SAI do documento (a citação continua no corpo, como texto) e fica
 * registrado nele como problema (`importIssues`):
 * - doc, skill, command: `docIds`/`docRefs`; agente: o contexto inicial e as skills e commands que ele libera;
 * - documento que é desta importação mas não entra AGORA (bloqueado, não aprovado, fora da seleção) fica PENDENTE e
 *   volta sozinho quando uma importação seguinte gravá-lo (`restoreImportLinks`).
 *
 * ⛔ SÓ O IMPORTADOR relaxa: a tela e a API que gravam um `docIds` ruim continuam recusando.
 */

/** O que a gravação enxerga para decidir cada vínculo. */
export interface ILinkWorld {
  projectId: string
  /** Os documentos (spec, ADR, estudo) que esta gravação escreve: id → tipo. */
  writtenDocs: ReadonlyMap<string, string>
  /** As skills e os commands que esta gravação escreve: id → tipo. */
  writtenResources: ReadonlyMap<string, string>
  /** O documento do catálogo com o id (qualquer tipo de doc). */
  catalogDoc: (id: string) => { kind: string; projectId?: string } | undefined
  /** A skill ou o command do catálogo com o id. */
  catalogResource: (id: string) => { kind: string; projectId?: string } | undefined
  /** É documento desta importação que não entra agora: o vínculo fica pendente. */
  pendingDoc: (id: string) => boolean
  /** O tipo de outra coisa com o id (um agente, um command, um arquivo de memória), quando não é documento. */
  otherKind: (id: string) => string | undefined
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  agent: 'um agente',
  command: 'um command',
  skill: 'uma skill',
  rule: 'uma rule',
  trigger: 'um trigger',
  mcp: 'um servidor MCP',
  config: 'um arquivo de configuração',
  unknown: 'um arquivo que não é documento (memória, nota)',
  skip: 'um arquivo que a importação deixa de fora',
  adr: 'uma ADR',
  knowledge: 'um estudo',
  spec: 'uma spec',
}
const labelOf = (kind: string) => KIND_LABEL[kind] ?? `um ${kind}`

const strings = (value: TCanonicalValue | undefined): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const isObject = (value: unknown): value is Record<string, TCanonicalValue> => !!value && typeof value === 'object' && !Array.isArray(value)

/** O vínculo com um documento: vale, ou o problema que ele vira. */
function docProblem(id: string, link: TImportProblemLink, world: ILinkWorld, onlySpec: boolean): IImportProblem | undefined {
  const base = { target: id, link }
  const written = world.writtenDocs.get(id)
  const found = written ? { kind: written } : world.catalogDoc(id)
  if (found) {
    if ('projectId' in found && found.projectId && found.projectId !== world.projectId)
      return { code: 'link-scope', message: `cita ${id}, que é de outro projeto (${found.projectId}): não vira vínculo`, ...base }
    if (onlySpec && found.kind !== 'spec') return { code: 'link-not-spec', message: `${id} é ${labelOf(found.kind)}: só spec vai no contexto inicial, e não entrou`, ...base }
    return undefined
  }
  if (world.pendingDoc(id))
    return { code: 'link-pending', message: `vínculo com ${id} pendente: ${id} ainda não está no catálogo (volta sozinho quando ${id} for importado)`, ...base }
  const other = world.otherKind(id)
  if (other) return { code: 'link-not-document', message: `cita ${id}, que é ${labelOf(other)}: não vira vínculo (a citação fica no texto)`, ...base }
  return { code: 'link-missing', message: `cita ${id}, que não existe no catálogo nem nesta importação: não vira vínculo (a citação fica no texto)`, ...base }
}

/** A skill ou o command que o agente libera: vale, ou o problema que ele vira. */
function grantProblem(id: string, kind: 'skill' | 'command', world: ILinkWorld): IImportProblem | undefined {
  if (id === ALL_RESOURCES || world.writtenResources.get(id) === kind) return undefined
  const found = world.catalogResource(id)
  if (found?.kind === kind) {
    if (found.projectId && found.projectId !== world.projectId)
      return { code: 'link-scope', message: `libera ${id}, que é de outro projeto (${found.projectId}): não entra`, target: id, link: kind }
    return undefined
  }
  const label = kind === 'skill' ? 'a skill' : 'o command'
  return {
    code: kind === 'skill' ? 'skill-missing' : 'command-missing',
    message: `libera ${label} ${id}, que ainda não está no catálogo: entra sozinha quando ${id} for importada`,
    target: id,
    link: kind,
  }
}

/** Junta os problemas novos aos que o documento já traz, sem repetir (código e alvo). */
function withProblems(body: TCanonicalBody, problems: readonly IImportProblem[]): TCanonicalBody {
  const all = [...problemList(body.importIssues), ...problems]
  const unique = all.filter((problem, index) => all.findIndex((other) => other.code === problem.code && other.target === problem.target) === index)
  const next: TCanonicalBody = { ...body }
  if (unique.length) next.importIssues = unique as unknown as TCanonicalValue[]
  else delete next.importIssues
  return next
}

/**
 * O documento do importador com os vínculos que valem; o que não vale sai e vira problema no próprio documento. Os
 * tipos sem vínculo (rule) passam iguais.
 */
export function withImportIssues(document: ICatalogDocument, world: ILinkWorld): ICatalogDocument {
  const body = document.body
  const problems: IImportProblem[] = []
  const next: TCanonicalBody = { ...body }
  switch (document.kind) {
    case 'spec':
    case 'adr':
    case 'knowledge':
    case 'skill':
    case 'command': {
      const refs = new Set(strings(body.docIds).length ? strings(body.docRefs) : [])
      const kept: string[] = []
      for (const id of strings(body.docIds)) {
        const problem = docProblem(id, refs.has(id) ? 'reference' : 'attach', world, false)
        if (problem) problems.push(problem)
        else kept.push(id)
      }
      next.docIds = kept
      const keptRefs = [...refs].filter((id) => kept.includes(id))
      if (keptRefs.length) next.docRefs = keptRefs
      else delete next.docRefs
      break
    }
    case 'agent': {
      const context: string[] = []
      for (const id of strings(body.initialContext)) {
        const problem = docProblem(id, 'initialContext', world, true)
        if (problem) problems.push(problem)
        else context.push(id)
      }
      next.initialContext = context
      const resources = isObject(body.resources) ? body.resources : undefined
      if (resources) {
        const granted = (field: 'skills' | 'commands', kind: 'skill' | 'command') =>
          strings(resources[field]).filter((id) => {
            const problem = grantProblem(id, kind, world)
            if (problem) problems.push(problem)
            return !problem
          })
        next.resources = { skills: granted('skills', 'skill'), commands: granted('commands', 'command') }
      }
      break
    }
    default:
      return document
  }
  return withBody(document, withProblems(next, problems))
}

/** O que esta gravação escreve, para os pendentes voltarem. */
export interface IRestorable {
  docs: ReadonlySet<string>
  skills: ReadonlySet<string>
  commands: ReadonlySet<string>
}

const appendTo = (list: readonly string[], id: string) => (list.includes(id) ? [...list] : [...list, id])

/**
 * O artefato do catálogo com os vínculos PENDENTES de volta: os `link-pending`/`skill-missing`/`command-missing` cujo
 * alvo esta gravação escreve. O vínculo volta no fim da lista (`docIds`, e `docRefs` se era por referência; o contexto
 * inicial; `resources`) e o problema sai. `undefined` = nada a voltar.
 */
export function restoreImportLinks(document: ICatalogDocument, written: IRestorable): ICatalogDocument | undefined {
  const problems = problemList(document.body.importIssues)
  const available = (problem: IImportProblem) => {
    if (!problem.target || !RESTORABLE_CODES.includes(problem.code)) return false
    if (problem.code === 'link-pending') return written.docs.has(problem.target)
    return (problem.code === 'skill-missing' ? written.skills : written.commands).has(problem.target)
  }
  const back = problems.filter(available)
  if (!back.length) return undefined
  const body: TCanonicalBody = { ...document.body }
  for (const problem of back) {
    const id = problem.target!
    switch (problem.link) {
      case 'attach':
      case 'reference':
        body.docIds = appendTo(strings(body.docIds), id)
        if (problem.link === 'reference') body.docRefs = appendTo(strings(body.docRefs), id)
        break
      case 'initialContext':
        body.initialContext = appendTo(strings(body.initialContext), id)
        break
      case 'skill':
      case 'command': {
        const resources = isObject(body.resources) ? body.resources : { skills: [ALL_RESOURCES], commands: [ALL_RESOURCES] }
        const field = problem.link === 'skill' ? 'skills' : 'commands'
        const current = strings(resources[field])
        // Com `*` ele já libera tudo do escopo: só o problema sai.
        body.resources = { ...resources, [field]: current.includes(ALL_RESOURCES) ? current : appendTo(current, id) }
        break
      }
      default:
        // Sem o vínculo guardado: não há o que voltar; o problema fica.
        continue
    }
  }
  const restored = new Set(back.filter((problem) => problem.link))
  const rest = problems.filter((problem) => !restored.has(problem))
  if (rest.length) body.importIssues = rest as unknown as TCanonicalValue[]
  else delete body.importIssues
  return withBody(document, body)
}
