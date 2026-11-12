import { secretNameIssue } from '@domain/models/ResourceSecret.Model'
import { randomUUID } from 'node:crypto'
import { agentIssues, IAgentRules } from '@domain/Agent.Policy'
import { toCapabilities } from '@domain/Capability.Catalog'
import { agentHash, agentWidenings, AGENT_PATCH_FIELDS, applyAgentPatch, requestedAgent, splitAgentPatchItems, TAgentPatch } from '@domain/AgentPatch.Policy'
import { confirmsWidenings, IWidening, TWideningItem, wideningKeys } from '@domain/Catalog.Widening'
import {
  AgentNotFoundError,
  CatalogWideningConfirmationError,
  InvalidAgentError,
  InvalidPermissionsError,
  PermissionRequestClosedError,
  PermissionRequestForbiddenError,
  PermissionRequestNotFoundError,
  ProjectNotFoundError,
} from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import {
  IPermissionRequest,
  IPermissionRequester,
  IPermissionRequestSecret,
  IPermissionWidening,
  PERMISSION_REQUEST_LIMITS,
  PERMISSION_REQUEST_TTL_DAYS,
  TPermissionRequestKind,
  TPermissionRequestStatus,
} from '@domain/models/PermissionRequest.Model'
import { IPermissionRule } from '@domain/Permission.Policy'
import { applyRuleChange, IRuleChange, requestExpiresAt, requestStatus, requestWidenings, ruleChangeIssues, rulesHash, splitRuleChange } from '@domain/PermissionRequest.Policy'
import { ICatalogEvents } from '@domain/ports/CatalogEvents.Port'
import { IPermissionRequestRepository } from '@domain/ports/PermissionRequestRepository.Port'
import type { AgentCatalog } from './Agent.Catalog'
import type { ICatalogChange } from './CatalogHistory.Service'

/** Um pedido como a tela e o agente o leem: o gravado, o estado de agora e as ampliações recalculadas sobre o alvo. */
export interface IPermissionRequestView extends Omit<IPermissionRequest, 'status' | 'widenings' | 'baseHash'> {
  status: TPermissionRequestStatus
  agentName?: string
  projectName?: string
  expiresAt: Date
  /** O que a aprovação abriria AGORA (no decidido, o que foi pedido): são estas as chaves do `confirm`. */
  widenings: IPermissionWidening[]
  /** As calculadas quando o agente pediu (auditoria). */
  requestedWidenings: IPermissionRequest['widenings']
  /** O alvo mudou desde o pedido: `widenings` foi recalculado. */
  changed: boolean
}

/** De quem são as regras: de um agente ou de um projeto (a camada de baixo). Um dos dois. */
export interface IRulesRef {
  agentId?: string
  projectId?: string
}

export interface IPermissionRulesView {
  layer: 'agent' | 'project'
  agentId?: string
  agentName?: string
  projectId?: string
  projectName?: string
  /** As regras da camada pedida. */
  rules: IPermissionRule[]
  /** 🔌 Agente de projeto conectado: as regras que vieram da origem (só leitura). As de `rules` são as desta máquina. */
  origin?: IPermissionRule[]
  /** As do projeto do agente (a camada de baixo), quando é um agente de projeto. */
  project?: { projectId: string; rules: IPermissionRule[] }
  /** Os pedidos ainda abertos (pendentes e vencidos) para este alvo. */
  pending: IPermissionRequestView[]
}

export interface IPermissionChangeInput {
  add?: unknown
  remove?: unknown
  reason?: unknown
}

export interface IPermissionChangeResult {
  agentId?: string
  projectId?: string
  /** O que já valeu (as restrições). */
  applied: IRuleChange
  /** Os pedidos com as ampliações, um por regra, se houve. ⛔ Nada deles vale antes da aprovação na tela. */
  pending?: IPermissionRequestView[]
  /** As regras agora. */
  rules: IPermissionRule[]
  /** O que o agente diz à pessoa (pt-BR, com o caminho da tela). */
  notice: string
}

export interface IAgentPatchResult {
  agentId: string
  /** Os campos que já valeram. */
  applied: string[]
  /** Um pedido por item (campo, ou entrada de lista). */
  pending?: IPermissionRequestView[]
  notice: string
}

/**
 * Quem decide. ⛔ `onScreen`: a pessoa entrou pela tela (a sessão de login no cookie, sem token de acesso). Agente, cliente
 * MCP e token de acesso chegam pelo cabeçalho e nunca são `onScreen` (ver `viaSessionCookie`).
 */
export interface IPermissionDecider {
  by: string
  onScreen: boolean
}

/** As regras do momento para gravar um agente inteiro (as do `PUT /agents`): o que a API valida além do domínio. */
export interface IAgentValidation {
  rules: Omit<IAgentRules, 'takenIds'>
  issues(agent: IAgent): Array<{ field: string; message: string }>
}

export interface IProjectRulesPort {
  exists(projectId: string): boolean
  name?(projectId: string): string | undefined
  rules(projectId: string): IPermissionRule[]
  save(projectId: string, rules: IPermissionRule[], by: string, change: Omit<ICatalogChange, 'by'>): IPermissionRule[]
}

/** A decisão de um pedido, para avisar a conversa que pediu (ver `PermissionDecisionNotice.Service`). */
export type TPermissionDecisionListener = (request: IPermissionRequestView, decider: Pick<IPermissionDecider, 'by'>) => void

export interface IPermissionRequestsDeps {
  /** As variáveis secretas: a aprovação de um pedido `secret` grava o valor digitado na tela. Ausente = sem esse pedido. */
  secrets?: {
    save(scope: 'agent' | 'skill' | 'command', scopeId: string, input: { name: string; description?: string; value?: string }, by: string, project?: string): unknown
    exists(scope: 'agent' | 'skill' | 'command', scopeId: string): boolean
  }
  repository: IPermissionRequestRepository
  agents: Pick<AgentCatalog, 'entry' | 'save' | 'savePermissions'>
  /**
   * 🔌 As regras LOCAIS de um agente de projeto conectado (ver `AgentLocalLayer.Service`): presentes, são elas que a
   * troca e a aprovação leem e gravam — o agente que veio da origem não muda. `undefined` = agente comum.
   */
  localRules?(agent: IAgent): { rules: IPermissionRule[]; save(rules: readonly IPermissionRule[], by: string): IPermissionRule[] } | undefined
  /**
   * 🔌 Ligar ferramentas, MCPs e delegações na camada LOCAL de um agente de projeto conectado (o pedido `agent-local`):
   * o agente como roda agora e como rodaria com elas, a conferência e a gravação. `undefined` = agente comum.
   */
  localLayer?(
    agent: IAgent,
    tools: readonly string[],
  ): { before: IAgent; after: IAgent; check(validation: IAgentValidation): void; save(validation: IAgentValidation, by: string): void } | undefined
  /** As regras dos projetos (a camada de baixo). Ausente: sem pedido de projeto. */
  projects?: IProjectRulesPort
  /** O aviso às telas abertas (`catalog.changed`, tipo `permission-request`): o pedido novo aparece sem reler. */
  events?: Pick<ICatalogEvents, 'publish'>
  now?: () => Date
  newId?: () => string
  ttlDays?: number
}

/** Um alvo de regras: a camada (agente ou projeto), as regras dela e como gravar. */
interface IRulesTarget {
  kind: Extract<TPermissionRequestKind, 'agent-rules' | 'project-rules'>
  item: TWideningItem
  agentId?: string
  projectId?: string
  name: string
  screen: string
  rules: IPermissionRule[]
  save(rules: IPermissionRule[], by: string, change: Omit<ICatalogChange, 'by'>): IPermissionRule[]
}

/**
 * OS PEDIDOS DE PERMISSÃO DOS AGENTES: o agente muda, pelo MCP do gateway, as regras de permissão de um agente (o dele
 * inclusive), as de um projeto, ou campos de um agente (`patch_agent`); o que RESTRINGE vale já, o que AMPLIA vira um
 * pedido pendente que só um administrador NA TELA aprova. 🔌 No agente de projeto conectado, o que se pede é para ESTA
 * máquina: a aprovação grava a camada local dele (regras, e ferramentas/MCPs/delegações com `agent-local`).
 *
 * ⛔ SEM CAMINHO DE APROVAÇÃO PARA AGENTE: o MCP do gateway não tem ferramenta de aprovar, a rota de aprovar recusa o
 * que não chegou pela sessão da tela (`onScreen`), e o serviço recusa de novo aqui — duas trancas, para a segunda valer
 * se um dia alguém ligar outra porta ao serviço.
 *
 * ⚖️ A aprovação confere o alvo de AGORA: as ampliações são recalculadas sobre o que ele é agora, e o `confirm` tem de
 * ser exatamente esse conjunto (como no import e no rollback). Mudou desde que a tela leu: 409 com a lista nova.
 */
export class PermissionRequestsService {
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly ttlDays: number
  private validation?: () => Promise<IAgentValidation>
  private decided?: TPermissionDecisionListener

  constructor(private readonly deps: IPermissionRequestsDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => randomUUID())
    this.ttlDays = deps.ttlDays ?? PERMISSION_REQUEST_TTL_DAYS
  }

  /** As regras do momento para gravar um agente inteiro (vêm do controller dos agentes, ligado na composição). */
  useAgentValidation(validation: () => Promise<IAgentValidation>): void {
    this.validation = validation
  }

  /** Quem ouve cada decisão (aprovado ou recusado): o aviso à conversa que pediu, ligado na composição. */
  useDecisionListener(listener: TPermissionDecisionListener): void {
    this.decided = listener
  }

  rules(ref: IRulesRef, options: { conversationProjectId?: string } = {}): IPermissionRulesView {
    const target = this.rulesTarget(ref)
    if (target.kind === 'project-rules')
      return {
        layer: 'project',
        projectId: target.projectId,
        projectName: target.name,
        rules: target.rules,
        pending: this.list({ projectId: target.projectId, kind: 'project-rules' }),
      }
    const agent = this.agent(target.agentId!)
    // O agente global: a camada de baixo é a do projeto da conversa, quando quem chama a conhece.
    const projectId = agent.projectId ?? options.conversationProjectId
    const project = projectId && this.deps.projects ? { projectId, rules: this.deps.projects.rules(projectId) } : undefined
    return {
      layer: 'agent',
      agentId: agent.id,
      agentName: agent.name,
      ...(agent.projectId ? { projectId: agent.projectId } : {}),
      rules: target.rules,
      ...(this.deps.localRules?.(agent) ? { origin: agent.permissions ?? [] } : {}),
      ...(project ? { project } : {}),
      pending: this.list({ agentId: agent.id }),
    }
  }

  /**
   * A troca de regras pedida pelo agente: valida tudo (o mesmo validador do formulário), aplica as restrições (com a
   * revisão no histórico: quem e o motivo) e guarda as ampliações num pedido. Sem ampliação, nenhum pedido.
   */
  change(ref: IRulesRef, input: IPermissionChangeInput, requester: IPermissionRequester): IPermissionChangeResult {
    const target = this.rulesTarget(ref)
    const current = target.rules
    const issues = ruleChangeIssues(input, current)
    if (issues.length) throw new InvalidPermissionsError(issues)
    const reason = String(input.reason).trim()
    const change: IRuleChange = { add: (input.add as IPermissionRule[] | undefined) ?? [], remove: (input.remove as IPermissionRule[] | undefined) ?? [] }
    const split = splitRuleChange(target.item, current, change)

    // A troca que não muda nada (a regra já estava lá) não grava revisão.
    const applied = rulesHash(split.rules) !== rulesHash(current) ? split.immediate : { add: [], remove: [] }
    if (applied.add.length || applied.remove.length) target.save(split.rules, label(requester), { source: 'agent', note: `pedido do agente: ${reason}` })

    // ⚖️ UM PEDIDO POR REGRA: a pessoa aprova uma e recusa outra. Cada um conta o que ELE abre, sobre as regras de agora.
    const items: IRuleChange[] = split.widenings.length
      ? [...split.pending.add.map((rule) => ({ add: [rule], remove: [] })), ...split.pending.remove.map((rule) => ({ add: [], remove: [rule] }))]
      : []
    const { ids, batch } = this.batch(items.length)
    const pending = items.length
      ? items.map((item, index) =>
          this.store(ids[index], {
            kind: target.kind,
            ...(target.agentId ? { agentId: target.agentId } : {}),
            ...(target.projectId ? { projectId: target.projectId } : {}),
            add: item.add.map(ruleOnly),
            remove: item.remove.map(ruleOnly),
            widenings: refs(requestWidenings(target.item, split.rules, item)),
            reason,
            requestedBy: requester,
            baseHash: rulesHash(split.rules),
            ...batch,
          }),
        )
      : undefined
    const done = [...applied.add.map((rule) => `+ ${ruleText(rule)}`), ...applied.remove.map((rule) => `- ${ruleText(rule)}`)]
    return {
      ...(target.agentId ? { agentId: target.agentId } : {}),
      ...(target.projectId && !target.agentId ? { projectId: target.projectId } : {}),
      applied,
      ...(pending ? { pending } : {}),
      rules: split.rules,
      notice: notice(target.screen, done, pending),
    }
  }

  /**
   * `patch_agent`: só os campos pedidos, pelo caminho normal de escrita do agente (as mesmas regras do `PUT`). O que
   * amplia (o detector do catálogo) vira pedido; o resto vale já. O agente inteiro, com o patch, é validado ANTES de
   * gravar qualquer parte: todos os problemas voltam juntos.
   */
  async patchAgent(agentId: string, input: { patch: TAgentPatch; reason: string }, requester: IPermissionRequester): Promise<IAgentPatchResult> {
    const reason = input.reason.trim()
    // ⚖️ Os ids antigos (`run_bash`, `search_web`) viram a capacidade, como no `save`: senão a ferramenta que o agente já
    // tem (gravada como `cap:`) pareceria nova, e o pedido ampliaria o que não amplia.
    if (Array.isArray(input.patch.allowedTools)) input = { ...input, patch: { ...input.patch, allowedTools: toCapabilities(input.patch.allowedTools as string[]) } }
    const fields = AGENT_PATCH_FIELDS.filter((field) => field in input.patch)
    const asked: Array<{ field: string; message: string }> = []
    if (!reason) asked.push({ field: 'reason', message: 'required: why the agent needs this (shown to whoever confirms)' })
    if (!fields.length) asked.push({ field: 'patch', message: `send at least one of: ${AGENT_PATCH_FIELDS.join(', ')}` })
    if (asked.length) throw new InvalidAgentError(asked)
    this.agent(agentId)
    const validation = await this.agentValidation()
    // Depois de esperar: daqui até gravar, nada assíncrono.
    const current = this.agent(agentId)
    const whole = applyAgentPatch(current, input.patch)
    const issues = [...validation.issues(whole), ...agentIssues(whole, { ...validation.rules, takenIds: [] })]
    if (issues.length) throw new InvalidAgentError(issues)

    const split = splitAgentPatchItems(current, input.patch)
    const appliedFields = agentHash(split.agent) !== agentHash(current) ? Object.keys(split.immediate) : []
    if (appliedFields.length)
      this.deps.agents.save(split.agent, { rules: validation.rules, by: label(requester), creating: false, change: { source: 'agent', note: `patch do agente: ${reason}` } })

    // ⚖️ UM PEDIDO POR ITEM: um campo, ou uma entrada acrescentada a uma lista (`agent:ana`, `cap:terminal`).
    const { ids, batch } = this.batch(split.items.length)
    const pending = split.items.length
      ? split.items.map((item, index) =>
          this.store(ids[index], {
            kind: 'agent-patch',
            agentId,
            ...(split.agent.projectId ? { projectId: split.agent.projectId } : {}),
            add: [],
            remove: [],
            ...(item.patch ? { patch: item.patch } : {}),
            ...(item.entries ? { entries: item.entries } : {}),
            widenings: refs(item.widenings),
            reason,
            requestedBy: requester,
            baseHash: agentHash(split.agent),
            ...batch,
          }),
        )
      : undefined
    const done = appliedFields.map((field) => `${field}`)
    return { agentId, applied: appliedFields, ...(pending ? { pending } : {}), notice: notice(agentScreen(split.agent.name), done, pending) }
  }

  /**
   * 🔌 `patch_agent` com `localLayer.allowedTools`: LIGAR ferramenta, MCP ou delegação num agente de projeto CONECTADO.
   * ⛔ Nada vale já: cada entrada vira um pedido, e a aprovação na tela grava a camada local DESTA máquina — o agente que
   * veio da origem não muda. O conjunto inteiro é conferido antes de nascer qualquer pedido.
   */
  async requestLocalTools(agentId: string, input: { allowedTools: readonly string[]; reason: string }, requester: IPermissionRequester): Promise<IAgentPatchResult> {
    const reason = input.reason.trim()
    const tools = [...new Set(input.allowedTools.map((tool) => tool.trim()).filter(Boolean))]
    const asked: Array<{ field: string; message: string }> = []
    if (!reason) asked.push({ field: 'reason', message: 'required: why the agent needs this (shown to whoever confirms)' })
    if (!tools.length) asked.push({ field: 'localLayer.allowedTools', message: 'send at least one tool, MCP (`mcp:<id>/*`) or agent (`agent:<id>`) to turn on' })
    if (asked.length) throw new InvalidAgentError(asked)
    this.agent(agentId)
    const validation = await this.agentValidation()
    // Depois de esperar: daqui até gravar, nada assíncrono.
    const agent = this.agent(agentId)
    const whole = this.deps.localLayer?.(agent, tools)
    if (!whole)
      throw new InvalidAgentError([
        { field: 'localLayer', message: 'only an agent of a CONNECTED project has a local layer: for any other agent, send `allowedTools` in the patch itself' },
      ])
    whole.check(validation)

    // ⚖️ UM PEDIDO POR ENTRADA, e só da que muda o agente (a que ele já tem ligada não vira pedido). A mesma entrada com
    // pedido aberto não repete: volta o que já está na fila.
    const open = this.deps.repository.list({ agentId, kind: 'agent-local', open: true }).filter((request) => requestStatus(request, this.now(), this.ttlDays) === 'pending')
    const waiting: IPermissionRequestView[] = []
    const fresh: Array<{ tool: string; widenings: IWidening[] }> = []
    for (const tool of tools) {
      const plan = this.deps.localLayer!(agent, [tool])!
      if (agentHash(plan.before) === agentHash(plan.after)) continue
      const same = open.find((request) => request.entries?.add.length === 1 && request.entries.add[0] === tool)
      if (same) waiting.push(this.view(same))
      else fresh.push({ tool, widenings: agentWidenings(plan.before, plan.after) })
    }
    const { ids, batch } = this.batch(fresh.length)
    const created = fresh.map((item, index) =>
      this.store(ids[index], {
        kind: 'agent-local',
        agentId,
        ...(agent.projectId ? { projectId: agent.projectId } : {}),
        add: [],
        remove: [],
        entries: { field: 'allowedTools', add: [item.tool] },
        widenings: refs(item.widenings),
        reason,
        requestedBy: requester,
        baseHash: agentHash(whole.before),
        ...batch,
      }),
    )
    const pending = [...created, ...waiting]
    return { agentId, applied: [], ...(pending.length ? { pending } : {}), notice: notice(agentScreen(agent.name), [], pending) }
  }

  /**
   * `request_secret`: o agente pede uma VARIÁVEL SECRETA pelo nome (ver `ResourceSecret.Model`). ⛔ Nada de valor aqui: a
   * pessoa digita o valor na tela, ao aprovar. Já existe? O pedido troca o valor (a pessoa decide).
   */
  requestSecret(input: IPermissionRequestSecret & { reason: string }, requester: IPermissionRequester): IPermissionRequestView {
    const reason = input.reason.trim()
    const issues: Array<{ field: string; message: string }> = []
    if (!this.deps.secrets) throw new PermissionRequestForbiddenError()
    if (!reason) issues.push({ field: 'reason', message: 'required: what the variable is for (shown to whoever fills it)' })
    const nameIssue = secretNameIssue(input.name)
    if (nameIssue) issues.push({ field: 'name', message: nameIssue })
    if (!this.deps.secrets.exists(input.scope, input.scopeId)) issues.push({ field: 'scopeId', message: `${input.scope} not found: ${input.scopeId}` })
    if (issues.length) throw new InvalidPermissionsError(issues)
    const secret: IPermissionRequestSecret = {
      scope: input.scope,
      scopeId: input.scopeId,
      name: input.name,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.project ? { project: input.project } : {}),
    }
    const agentId = input.scope === 'agent' ? input.scopeId : requester.agentId
    const agent = agentId ? this.deps.agents.entry(agentId)?.agent : undefined
    return this.store(this.newId(), {
      kind: 'secret',
      ...(agentId ? { agentId } : {}),
      ...(agent?.projectId ? { projectId: agent.projectId } : {}),
      add: [],
      remove: [],
      secret,
      widenings: refs([secretWidening(secret)]),
      reason,
      requestedBy: requester,
      baseHash: '',
    })
  }

  /** Os pedidos: os abertos (pendentes e vencidos) por padrão; `all` traz os decididos também. */
  list(filter: { agentId?: string; projectId?: string; kind?: TPermissionRequestKind; all?: boolean } = {}): IPermissionRequestView[] {
    const { all, ...rest } = filter
    return this.deps.repository.list({ ...rest, open: !all }).map((request) => this.view(request))
  }

  get(id: string): IPermissionRequestView {
    const request = this.deps.repository.get(id)
    if (!request) throw new PermissionRequestNotFoundError(id)
    return this.view(request)
  }

  /**
   * ⛔ APROVAR: só na tela; só pendente que não venceu; `confirm` = exatamente as ampliações sobre o alvo de AGORA. Grava
   * pelo caminho normal (do agente ou do projeto), com as chaves aceitas na revisão. Depois de ler as regras do momento
   * (a única espera), tudo é síncrono: nada entra entre conferir e gravar.
   */
  async approve(
    id: string,
    confirm: readonly string[] | undefined,
    decider: IPermissionDecider,
    value?: string,
  ): Promise<{ request: IPermissionRequestView; permissions?: IPermissionRule[] }> {
    if (!decider.onScreen) throw new PermissionRequestForbiddenError()
    // ⛔ A variável pedida: o valor que a pessoa digitou na tela vai direto ao cofre — nunca ao pedido, nunca ao histórico.
    const pending = this.open(id)
    if (pending.kind === 'secret' && pending.secret) {
      gate([secretWidening(pending.secret)], confirm)
      if (!value?.trim()) throw new InvalidPermissionsError([{ field: 'value', message: 'type the value of the variable' }])
      if (!this.deps.secrets) throw new PermissionRequestForbiddenError()
      this.deps.secrets.save(
        pending.secret.scope,
        pending.secret.scopeId,
        { name: pending.secret.name, ...(pending.secret.description ? { description: pending.secret.description } : {}), value },
        decider.by,
        pending.secret.project,
      )
      this.deps.repository.decide(id, { status: 'approved', by: decider.by, at: this.now() })
      this.publish(pending)
      return { request: this.settled(id, decider) }
    }
    const validation = pending.kind === 'agent-patch' || pending.kind === 'agent-local' ? await this.agentValidation() : undefined
    const request = this.open(id)
    const note = `pedido de permissão ${request.id} aprovado (pedido por ${label(request.requestedBy)}): ${request.reason}`
    let permissions: IPermissionRule[] | undefined
    if (request.kind === 'agent-patch') {
      const agent = this.agent(request.agentId!)
      // ⛔ O patch grava o agente inteiro: o de projeto conectado é da origem.
      if (this.deps.localRules?.(agent)) throw new PermissionRequestForbiddenError()
      const target = requestedAgent(agent, request)
      const widenings = agentWidenings(agent, target)
      gate(widenings, confirm)
      const issues = validation!.issues(target)
      if (issues.length) throw new InvalidAgentError(issues)
      const saved = this.deps.agents.save(target, {
        rules: validation!.rules,
        by: decider.by,
        creating: false,
        change: { source: 'api', note, widenings: wideningKeys(widenings) },
      })
      permissions = saved.permissions ?? []
    } else if (request.kind === 'agent-local') {
      // 🔌 Só a camada local desta máquina: o agente que veio da origem não é gravado.
      const plan = this.deps.localLayer?.(this.agent(request.agentId!), request.entries?.add ?? [])
      if (!plan) throw new PermissionRequestForbiddenError()
      gate(agentWidenings(plan.before, plan.after), confirm)
      plan.save(validation!, decider.by)
    } else {
      const target = this.rulesTarget(request)
      const widenings = requestWidenings(target.item, target.rules, request)
      gate(widenings, confirm)
      permissions = target.save(applyRuleChange(target.rules, request), decider.by, { source: 'api', note, widenings: wideningKeys(widenings) })
    }
    this.deps.repository.decide(id, { status: 'approved', by: decider.by, at: this.now() })
    this.publish(request)
    return { request: this.settled(id, decider), ...(permissions ? { permissions } : {}) }
  }

  /** Recusar (ou descartar o vencido): só admin, mas não precisa ser na tela — recusar nunca abre acesso. */
  reject(id: string, decider: Pick<IPermissionDecider, 'by'>, note?: string): IPermissionRequestView {
    const request = this.deps.repository.get(id)
    if (!request) throw new PermissionRequestNotFoundError(id)
    if (request.status !== 'pending') throw new PermissionRequestClosedError(id, request.status)
    const text = note?.trim().slice(0, PERMISSION_REQUEST_LIMITS.note)
    if (!this.deps.repository.decide(id, { status: 'rejected', by: decider.by, at: this.now(), ...(text ? { note: text } : {}) }))
      throw new PermissionRequestClosedError(id, this.deps.repository.get(id)?.status ?? 'decided')
    this.publish(request)
    return this.settled(id, decider)
  }

  /** O pedido decidido, como ficou — e o aviso a quem ouve as decisões. ⛔ O aviso nunca derruba a decisão já gravada. */
  private settled(id: string, decider: Pick<IPermissionDecider, 'by'>): IPermissionRequestView {
    const view = this.get(id)
    try {
      this.decided?.(view, decider)
    } catch (error) {
      console.warn('[pedidos de permissão] não foi possível avisar a conversa que pediu:', error)
    }
    return view
  }

  private store(id: string, fields: Omit<IPermissionRequest, 'id' | 'createdAt' | 'status'>): IPermissionRequestView {
    const request: IPermissionRequest = { id, ...fields, createdAt: this.now(), status: 'pending' }
    this.deps.repository.create(request)
    this.publish(request)
    return this.view(request)
  }

  /** Os ids dos itens de uma chamada e o lote deles (o id do primeiro): só com mais de um — um item só não precisa de grupo. */
  private batch(items: number): { ids: string[]; batch: { batchId?: string } } {
    const ids = Array.from({ length: items }, () => this.newId())
    return { ids, batch: items > 1 ? { batchId: ids[0] } : {} }
  }

  /** O pedido aprovável: existe, está pendente e não venceu. */
  private open(id: string): IPermissionRequest {
    const request = this.deps.repository.get(id)
    if (!request) throw new PermissionRequestNotFoundError(id)
    const status = requestStatus(request, this.now(), this.ttlDays)
    if (status !== 'pending') throw new PermissionRequestClosedError(id, status)
    return request
  }

  private async agentValidation(): Promise<IAgentValidation> {
    if (!this.validation) throw new Error('agent validation is not wired (useAgentValidation)')
    return this.validation()
  }

  private agent(id: string): IAgent {
    const entry = this.deps.agents.entry(id)
    if (!entry) throw new AgentNotFoundError(id)
    return entry.agent
  }

  /** O alvo das regras: o agente (`agentId`) ou, sem ele, o projeto. */
  private rulesTarget(ref: IRulesRef): IRulesTarget {
    if (ref.agentId) {
      const agent = this.agent(ref.agentId)
      const local = this.deps.localRules?.(agent)
      return {
        kind: 'agent-rules',
        item: agentItem(agent),
        agentId: agent.id,
        ...(agent.projectId ? { projectId: agent.projectId } : {}),
        name: agent.name,
        screen: agentScreen(agent.name),
        rules: local ? local.rules : (agent.permissions ?? []),
        save: local ? (rules, by) => local.save(rules, by) : (rules, by, change) => this.deps.agents.savePermissions(agent.id, rules, by, change).permissions ?? [],
      }
    }
    const projects = this.deps.projects
    const projectId = ref.projectId ?? ''
    if (!projects || !projects.exists(projectId)) throw new ProjectNotFoundError(projectId)
    const name = projects.name?.(projectId) ?? projectId
    return {
      kind: 'project-rules',
      item: { kind: 'project-permissions', id: projectId, projectId },
      projectId,
      name,
      screen: `Projeto ${name} → Permissões → Pedidos pendentes`,
      rules: projects.rules(projectId),
      save: (rules, by, change) => projects.save(projectId, rules, by, change),
    }
  }

  private view(request: IPermissionRequest): IPermissionRequestView {
    const { status, widenings: requested, baseHash, ...rest } = request
    const open = status === 'pending'
    const agent = request.agentId ? this.deps.agents.entry(request.agentId)?.agent : undefined
    const projectName = request.kind === 'project-rules' && request.projectId ? (this.deps.projects?.name?.(request.projectId) ?? request.projectId) : undefined
    let widenings: IPermissionWidening[] = requested
    let changed = false
    if (open) {
      try {
        if (request.kind === 'secret') {
          // Nada a recalcular: a variável é só o nome pedido.
        } else if (request.kind === 'agent-patch' && agent) {
          widenings = refs(agentWidenings(agent, requestedAgent(agent, request)))
          changed = agentHash(agent) !== baseHash
        } else if (request.kind === 'agent-local') {
          const plan = agent ? this.deps.localLayer?.(agent, request.entries?.add ?? []) : undefined
          if (plan) {
            widenings = refs(agentWidenings(plan.before, plan.after))
            changed = agentHash(plan.before) !== baseHash
          }
        } else if (request.kind !== 'agent-patch') {
          const target = this.rulesTarget(request)
          widenings = refs(requestWidenings(target.item, target.rules, request))
          changed = rulesHash(target.rules) !== baseHash
        }
      } catch {
        // O alvo sumiu (agente ou projeto apagado): fica o que foi pedido; aprovar responde 404.
      }
    }
    return {
      ...rest,
      status: requestStatus(request, this.now(), this.ttlDays),
      ...(agent ? { agentName: agent.name } : {}),
      ...(projectName ? { projectName } : {}),
      expiresAt: requestExpiresAt(request, this.ttlDays),
      widenings,
      requestedWidenings: requested,
      changed,
    }
  }

  private publish(request: Pick<IPermissionRequest, 'agentId' | 'projectId' | 'kind'>): void {
    // ⛔ O aviso nunca derruba a escrita. `id`: o agente, ou o projeto no pedido de projeto.
    try {
      const id = request.agentId ?? request.projectId ?? ''
      this.deps.events?.publish([{ kind: 'permission-request', id, ...(request.projectId ? { projectId: request.projectId } : {}), op: 'update' }])
    } catch (error) {
      console.warn('[pedidos de permissão] não foi possível avisar as telas:', error)
    }
  }
}

/** ⛔ `confirm` = exatamente as ampliações de agora; sem ampliação, vazio (confirmação que não bate é ver outra coisa). */
function gate(widenings: readonly IWidening[], confirm: readonly string[] | undefined): void {
  const mismatch = widenings.length ? !confirm || !confirmsWidenings(confirm, widenings) : !!confirm?.length
  if (mismatch) throw new CatalogWideningConfirmationError(refs(widenings))
}

const refs = (widenings: readonly IWidening[]): IPermissionWidening[] => widenings.map(({ key, description }) => ({ key, description }))

/** O agente como item das chaves de ampliação (o mesmo do catálogo: `agent/<id>[@<projeto>]`). */
const agentItem = (agent: Pick<IAgent, 'id' | 'projectId'>): TWideningItem => ({ kind: 'agent', id: agent.id, ...(agent.projectId ? { projectId: agent.projectId } : {}) })

const agentScreen = (name: string) => `Agentes → ${name} → Permissões → Pedidos pendentes`

/** Só o que a regra é: é o que o pedido guarda e a aprovação aplica. A nota vai junto se veio. */
const ruleOnly = (rule: IPermissionRule): IPermissionRule => ({
  category: rule.category,
  pattern: rule.pattern.trim(),
  decision: rule.decision,
  ...(rule.note?.trim() ? { note: rule.note.trim() } : {}),
})

/** Quem pediu, para o histórico: `agent:theo (conversa c1) por ana@x` — ou só a conta, fora de conversa. */
export function label(requester: IPermissionRequester): string {
  if (!requester.agentId) return requester.by
  return `agent:${requester.agentId}${requester.conversationId ? ` (conversa ${requester.conversationId})` : ''} por ${requester.by}`
}

const ruleText = (rule: IPermissionRule) => `${rule.decision === 'allow' ? 'permitir' : 'negar'} ${rule.category} "${rule.pattern}"`

/**
 * ⛔ O QUE O AGENTE DIZ À PESSOA: o que já valeu, e — havendo pedido — que as ampliações NÃO valem até ela confirmar na
 * tela, com o caminho e a lista. Sem isso o agente diria "liberado" a quem não liberou nada.
 */
function notice(screen: string, done: readonly string[], pending: readonly IPermissionRequestView[] | undefined): string {
  const lines: string[] = []
  if (done.length) lines.push(`Aplicado agora (restringe ou não abre acesso):`, ...done.map((line) => `  ${line}`))
  if (pending?.length) {
    lines.push(
      `PENDENTE — NÃO aplicado: ${pending.length === 1 ? 'esta mudança amplia' : `estas ${pending.length} mudanças ampliam`} acesso e só ${pending.length === 1 ? 'vale' : 'valem'} depois que um administrador confirmar NA TELA, em ${screen} (ou no menu da conta → Notificações, onde ela aprova ou recusa um por um, ou aprova todos de uma vez). Vencem em ${pending[0].expiresAt.toISOString().slice(0, 10)}.`,
      ...pending.map((item) => `  • ${itemLine(item)} (pedido ${item.id})`),
      `Avise a pessoa agora, com a lista acima. Não diga que o acesso foi liberado: até ela confirmar na tela, nada disso vale. Quando ela decidir, o gateway avisa nesta conversa: não fique conferindo.`,
    )
  }
  if (!lines.length) lines.push('Nada mudou: já estava assim.')
  return lines.join('\n')
}

/** Um item do pedido em uma linha: o que ele amplia, ou o que ele muda. */
export function itemLine(item: IPermissionRequestView): string {
  // 🔌 Ligar na camada local: diz que é só desta máquina (e cobre o religar, que não tem ampliação a descrever).
  if (item.kind === 'agent-local') {
    const what = item.widenings.length ? item.widenings.map((widening) => widening.description).join('; ') : `ligar de novo ${item.entries?.add.join(', ') ?? ''}`
    return `${what} — só nesta máquina (camada local${item.agentName ? ` de ${item.agentName}` : ''})`
  }
  if (item.widenings.length) return item.widenings.map((widening) => widening.description).join('; ')
  if (item.entries) return `${item.entries.field} + ${item.entries.add.join(', ')}`
  return Object.keys(item.patch ?? {}).join(', ') || [...item.add, ...item.remove].map(ruleText).join(', ')
}

/** A ampliação de um pedido `secret`: o recurso passa a ter a variável (o valor que a pessoa digitar). */
function secretWidening(secret: IPermissionRequestSecret): IWidening {
  const target = secret.scope === 'agent' ? `o agente ${secret.scopeId}` : `a ${secret.scope === 'skill' ? 'skill' : 'command'} ${secret.scopeId}`
  return {
    kind: secret.scope,
    id: secret.scopeId,
    category: 'environment',
    key: `secret/${secret.scope}/${secret.scopeId}${secret.project ? `@${secret.project}` : ''}#${secret.name}`,
    description: `variável secreta ${secret.name} para ${target}${secret.project ? ` (no projeto ${secret.project})` : ''}`,
  }
}
