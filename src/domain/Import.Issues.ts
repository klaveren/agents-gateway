import { ICatalogDocument, TCanonicalBody, TCanonicalValue } from './Catalog.Document'
import { withBody } from './Catalog.Import'
import { IImportProblem, problemList, RESTORABLE_CODES, TImportProblemLink } from './models/ImportProblem.Model'
import { ALL_RESOURCES } from './models/Resource.Model'
import { AGENT_TOOL_PREFIX } from './models/Delegation.Model'
import { parseMcpToolRef } from './models/McpServer.Model'
import { DELEGATE_PENDING_NOTE } from './Import.Permissions'
import { IPermissionRule } from './Permission.Policy'

/**
 * OS VÍNCULOS DA IMPORTAÇÃO QUE NÃO BLOQUEIAM (puro). O rascunho aprovado cita, pelo `linkCitation`, o que achou no
 * texto; o que não vira vínculo válido no catálogo SAI do documento (a citação continua no corpo, como texto) e fica
 * registrado nele como problema (`importIssues`):
 * - doc, skill, command: `docIds`/`docRefs`; agente: o contexto inicial e as skills e commands que ele libera;
 * - documento que é desta importação mas não entra AGORA (bloqueado, não aprovado, fora da seleção) fica PENDENTE e
 *   volta sozinho quando uma importação seguinte gravá-lo (`restoreImportLinks`);
 * - o ALCANCE do agente que cita um alvo que não existe — liberar delegar a um agente exato, ou um servidor MCP exato
 *   (regra ou `allowedTools`) — sai e fica GUARDADO no problema (`delegate-missing`, `mcp-missing`), exato, para voltar.
 *   ⛔ Voltar não concede nada sozinho: a regra volta no documento e vira ampliação a confirmar naquela gravação.
 *   ⚖️ Negar fica (só restringe); curinga (`agent-*`, `*`, `mcp` do servidor `*`) fica: segue como ampliação.
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
  /** O agente com o id existe no catálogo ou entra nesta gravação. */
  agentExists: (id: string) => boolean
  /** O servidor MCP que o agente do projeto (ausente: global) enxerga — global ou do projeto dele —, no catálogo ou nesta gravação. */
  mcpExists: (id: string, projectId: string | undefined) => boolean
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

/** O alvo EXATO que a liberação cita: o agente da delegação, ou o servidor MCP. Negar e curinga: nenhum (ficam). */
function ruleTarget(rule: IPermissionRule): { code: 'delegate-missing' | 'mcp-missing'; id: string } | undefined {
  if (rule.decision !== 'allow') return undefined
  const pattern = rule.pattern.trim()
  if (rule.category === 'delegate') return pattern && !pattern.includes('*') ? { code: 'delegate-missing', id: pattern } : undefined
  if (rule.category !== 'mcp') return undefined
  const server = pattern.includes('/') ? pattern.slice(0, pattern.indexOf('/')) : ''
  return server && !server.includes('*') ? { code: 'mcp-missing', id: server } : undefined
}

/** O alvo exato de uma entrada de `allowedTools` (`agent:<id>`, `mcp:<servidor>/…`). `cap:` e o resto: nenhum. */
function toolTarget(tool: string): { code: 'delegate-missing' | 'mcp-missing'; id: string } | undefined {
  if (tool.startsWith(AGENT_TOOL_PREFIX)) {
    const id = tool.slice(AGENT_TOOL_PREFIX.length)
    return id && !id.includes('*') ? { code: 'delegate-missing', id } : undefined
  }
  const ref = parseMcpToolRef(tool)
  return ref && !ref.server.includes('*') ? { code: 'mcp-missing', id: ref.server } : undefined
}

const REACH_MESSAGE = {
  'delegate-missing': (id: string) => `permite delegar a ${id}, que ainda não existe: a regra fica guardada e volta quando ${id} for importado (com a confirmação da ampliação)`,
  'mcp-missing': (id: string) => `usa o servidor MCP ${id}, que ainda não existe: fica guardado e volta quando ${id} for importado (com a confirmação da ampliação)`,
}

/** O alcance do agente sem o que cita alvo que não existe; o que saiu vira um problema por alvo, com o que guardar. */
function heldReach(body: TCanonicalBody, projectId: string | undefined, world: ILinkWorld) {
  const held = new Map<string, IImportProblem & { rules: IPermissionRule[]; tools: string[] }>()
  const missing = (target: { code: 'delegate-missing' | 'mcp-missing'; id: string } | undefined) => {
    if (!target) return undefined
    const exists = target.code === 'delegate-missing' ? world.agentExists(target.id) : world.mcpExists(target.id, projectId)
    if (exists) return undefined
    const key = `${target.code}|${target.id}`
    if (!held.has(key)) held.set(key, { code: target.code, message: REACH_MESSAGE[target.code](target.id), target: target.id, link: 'reach', rules: [], tools: [] })
    return held.get(key)!
  }
  const rules = Array.isArray(body.permissions) ? (body.permissions as unknown as IPermissionRule[]) : undefined
  const keptRules = (rules ?? []).filter((rule) => {
    const problem = missing(ruleTarget(rule))
    problem?.rules.push(rule)
    return !problem
  })
  const keptTools = strings(body.allowedTools).filter((tool) => {
    const problem = missing(toolTarget(tool))
    problem?.tools.push(tool)
    return !problem
  })
  const problems: IImportProblem[] = [...held.values()].map(({ rules, tools, ...problem }) => ({
    ...problem,
    ...(rules.length ? { rules } : {}),
    ...(tools.length ? { tools } : {}),
  }))
  return { rules: rules && keptRules, tools: keptTools, problems }
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
      const reach = heldReach(body, document.projectId, world)
      if (reach.problems.length) {
        if (reach.rules) next.permissions = reach.rules as unknown as TCanonicalValue[]
        if (body.allowedTools !== undefined) next.allowedTools = reach.tools
        problems.push(...reach.problems)
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
  /** Os agentes e os servidores MCP: o alcance guardado (`delegate-missing`, `mcp-missing`) volta. */
  agents: ReadonlySet<string>
  mcps: ReadonlySet<string>
}

const appendTo = (list: readonly string[], id: string) => (list.includes(id) ? [...list] : [...list, id])

/**
 * O artefato do catálogo com os vínculos PENDENTES de volta: os `link-pending`/`skill-missing`/`command-missing`/
 * `delegate-missing`/`mcp-missing` cujo alvo esta gravação escreve. O vínculo volta no fim da lista (`docIds`, e
 * `docRefs` se era por referência; o contexto inicial; `resources`; `permissions` e `allowedTools`) e o problema sai.
 * `undefined` = nada a voltar.
 *
 * ⛔ O alcance que volta passa pela trava de ampliação do plano como qualquer outro: sem a caixa marcada, não entra.
 */
export function restoreImportLinks(document: ICatalogDocument, written: IRestorable): ICatalogDocument | undefined {
  const problems = problemList(document.body.importIssues)
  const available = (problem: IImportProblem) => {
    if (!problem.target || !RESTORABLE_CODES.includes(problem.code)) return false
    if (problem.code === 'link-pending') return written.docs.has(problem.target)
    if (problem.code === 'delegate-missing') return written.agents.has(problem.target)
    if (problem.code === 'mcp-missing') return written.mcps.has(problem.target)
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
      case 'reach': {
        const rules = Array.isArray(body.permissions) ? [...(body.permissions as unknown as IPermissionRule[])] : []
        const same = (a: IPermissionRule, b: IPermissionRule) => a.category === b.category && a.decision === b.decision && a.pattern === b.pattern
        // ⚖️ A nota do tradutor ("alvo ainda não importado") deixa de ser verdade: sai; o resto da regra volta exato.
        for (const rule of problem.rules ?? []) {
          const { note, ...exact } = rule
          const back = note && note !== DELEGATE_PENDING_NOTE ? { ...exact, note } : exact
          if (!rules.some((one) => same(one, back))) rules.push(back)
        }
        if (rules.length) body.permissions = rules as unknown as TCanonicalValue[]
        let tools = strings(body.allowedTools)
        for (const tool of problem.tools ?? []) tools = appendTo(tools, tool)
        if (tools.length || body.allowedTools !== undefined) body.allowedTools = tools
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
