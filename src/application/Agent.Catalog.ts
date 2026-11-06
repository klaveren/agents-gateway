import { fileIssues, IResourceFile, sortFiles } from '@domain/models/ResourceFile.Model'
import { IResourceFilesPort } from '@domain/ports/ResourceFiles.Port'
import { toCapabilities } from '@domain/Capability.Catalog'
import { agentIssues, IAgentRules, triggerIssues } from '@domain/Agent.Policy'
import { AgentInUseError, AgentNotFoundError, GuidanceNotFoundError, InvalidAgentError } from '@domain/errors/Domain.Error'
import { describeMatch, IImportProblemMatch, withoutProblem } from '@domain/models/ImportProblem.Model'
import { diagnosticsOn, IAgent, IAgentTarget, IAgentTrigger } from '@domain/models/Agent.Model'
import { IAgentDirectory, IAgentRepository, IStoredAgent } from '@domain/ports/AgentRepository.Port'
import { cleanRules, IPermissionRule, permissionIssues } from '@domain/Permission.Policy'
import { CatalogHistoryHook, ICatalogChange } from './CatalogHistory.Service'

/** Um agente na lista da tela, com quem mexeu por último. */
export interface IAgentEntry {
  agent: IAgent
  updatedAt?: Date
  updatedBy?: string
}

/** O que `AgentCatalog.save` precisa além do agente: as regras do momento e quem está salvando. */
export interface ISaveAgentOptions {
  rules: Omit<IAgentRules, 'takenIds'>
  by: string
  /** `true` cria (o id não pode existir); `false` atualiza (o id tem de existir). */
  creating: boolean
  /** Por onde veio, a nota e as ampliações aceitas — vão na revisão (o `patch_agent` e a aprovação na tela). */
  change?: Omit<ICatalogChange, 'by'>
}

/**
 * Os agentes do gateway — todos no banco, editáveis e apagáveis (a semente entra uma vez, ver `seedOnce`).
 *
 * ⚠️ Sessão já aberta fica com o agente com que nasceu: o adapter compõe o prompt na criação, e
 * mudar o agente aqui vale para a PRÓXIMA sessão.
 */
export class AgentCatalog implements IAgentDirectory {
  /** O histórico do catálogo: toda escrita grava a revisão do agente (ver `CatalogHistory.Service`). */
  readonly history = new CatalogHistoryHook()

  constructor(
    private readonly repository: IAgentRepository,
    /**
     * Quais modelos do agente podem ser usados AGORA — os ativados no catálogo do provider. Ausente,
     * todos os declarados. ⚖️ Desativar um modelo o tira de TODOS os agentes na leitura, sem reescrever
     * nenhum: religar devolve.
     */
    private readonly usable?: (providerId: string, modelId: string) => boolean,
    /**
     * Um provider do agente pode rodar agora (ver `targetUnavailable`) — ligado, modelo ativo, chave.
     * Ausente: todo provider com modelo conta. O agente roda se algum provider roda: é o que escolhe o
     * PADRÃO, os alvos de delegação e o provider com que a sessão nasce.
     */
    private readonly runnable?: (agent: IAgent, target: IAgentTarget) => boolean,
    /**
     * Os agentes do CORE (o construtor, ver `Builder.Agents`): definidos no código, montados na hora com o modelo das
     * configurações. ⚖️ `get` os acha — é por ele que a sessão abre; `list` não os mostra — fora da tela, do padrão e
     * da delegação. E os ids deles não servem para agente do catálogo.
     */
    private readonly core: () => IAgent[] = () => [],
  ) {}

  /** O depósito e as pastas dos arquivos de recurso (ver `ResourceFile.Model`). Sem ele, agente com arquivo é recusado. */
  useFiles(files: IResourceFilesPort): void {
    this.files = files
  }

  private files?: IResourceFilesPort

  /**
   * ⛔ A PASTA PRIVADA do agente: existe para todo agente (vazia, até alguém pôr algo), e só ele a alcança. Lê com Ler
   * arquivos ou Terminal; grava com Escrever arquivos (ver `agentFolderAccess`). Nada sem o depósito.
   */
  filesDir(agent: Pick<IAgent, 'id' | 'projectId'>): string | undefined {
    return this.files?.dirOf('agent', agent.id, agent.projectId)
  }

  /** A pasta como está no disco: os arquivos postos pela tela e os que o agente gravou (o que a guia Arquivos mostra). */
  liveFiles(agent: Pick<IAgent, 'id' | 'projectId'>): IResourceFile[] | undefined {
    return this.files?.snapshotAgent(agent.id, agent.projectId)
  }

  /** Os agentes com os modelos que podem ser usados agora. */
  list(): IAgent[] {
    return this.entries().map((entry) => entry.agent)
  }

  /** Como `rawEntries`, com os modelos filtrados pelo catálogo — o que a API e as sessões enxergam. */
  entries(): IAgentEntry[] {
    return this.rawEntries().map((entry) => ({ ...entry, agent: this.effective(entry.agent) }))
  }

  /** Os agentes COMO GRAVADOS (todos os modelos declarados) — a tela de edição e a semente do catálogo. */
  rawEntries(): IAgentEntry[] {
    return this.repository.list().map((stored) => ({ agent: toAgent(stored), updatedAt: stored.updatedAt, updatedBy: stored.updatedBy }))
  }

  get(id: string): IAgent | undefined {
    return this.list().find((agent) => agent.id === id) ?? this.core().find((agent) => agent.id === id)
  }

  /** Os modelos declarados que estão DESLIGADOS no catálogo — a tela de edição os mostra marcados. */
  unusableModels(agent: IAgent): Record<string, string[]> {
    if (!this.usable) return {}
    return Object.fromEntries(
      agent.providers.map((target) => [target.provider, target.models.filter((model) => !this.usable!(target.provider, model))] as const).filter(([, models]) => models.length),
    )
  }

  private effective(agent: IAgent): IAgent {
    if (!this.usable) return agent
    return { ...agent, providers: agent.providers.map((target) => ({ ...target, models: target.models.filter((model) => this.usable!(target.provider, model)) })) }
  }

  /** O agente como gravado, para editar: os modelos desligados aparecem (ver `unusableModels`). */
  entry(id: string): IAgentEntry | undefined {
    return this.rawEntries().find((entry) => entry.agent.id === id)
  }

  /**
   * O que vale quando ninguém escolheu agente: o primeiro que PODE abrir conversa e não é subagente.
   * ⚠️ Antes era só o primeiro da lista — que podia estar com o provider desligado, sem modelo ou ser
   * subagente, e toda conversa sem agente escolhido falhava.
   */
  fallback(): IAgent | undefined {
    return this.list().find((agent) => agent.role !== 'subagent' && this.isRunnable(agent))
  }

  isModelUsable(provider: string, model: string): boolean {
    return this.usable ? this.usable(provider, model) : true
  }

  /** O agente (já com os modelos utilizáveis) pode abrir conversa agora: algum provider dele roda. */
  isRunnable(agent: IAgent): boolean {
    return agent.providers.some((target) => this.isTargetRunnable(agent, target))
  }

  /** Este provider do agente (já com os modelos utilizáveis) pode rodar agora. */
  isTargetRunnable(agent: IAgent, target: IAgentTarget): boolean {
    return target.models.length > 0 && (this.runnable ? this.runnable(agent, target) : true)
  }

  save(input: IAgent, options: ISaveAgentOptions): IStoredAgent {
    // ⚖️ Os ids antigos (`run_bash`, `sdk:Read`…) viram a capacidade: quem salva pelo MCP ou pela API com o formato de
    // antes continua funcionando, e o agente fica gravado do jeito novo.
    const agent = { ...input, allowedTools: toCapabilities(input.allowedTools) }
    if (!options.creating && !this.repository.list().some((stored) => stored.id === agent.id)) throw new AgentNotFoundError(agent.id)

    // Na criação nenhum id existente serve; na atualização, o próprio é este.
    const takenIds = options.creating ? [...this.list(), ...this.core()].map((existing) => existing.id) : []
    const issues = agentIssues(agent, { ...options.rules, takenIds })
    if (!issues.length && agent.files?.length) {
      if (!this.files) issues.push({ field: 'files', message: 'resource files are not available on this gateway' })
      else agent.files.forEach((file, index) => !this.files!.has(file.sha256) && issues.push({ field: `files[${index}].sha256`, message: `content not uploaded: ${file.path}` }))
    }
    if (issues.length) throw new InvalidAgentError(issues)

    const before = this.repository.list().find((stored) => stored.id === agent.id)
    const saved = this.repository.save(agent.files?.length ? { ...agent, files: sortFiles(agent.files) } : agent, options.by)
    this.placeFiles(before ? toAgent(before) : undefined, saved)
    this.history.record([{ kind: 'agent', id: agent.id }], { ...options.change, by: options.by })
    return saved
  }

  /**
   * ⚖️ A pasta do agente acompanha o registro sem perder o que ELE gravou: muda de lugar com o projeto (inteira), grava
   * os arquivos da lista nova e apaga só o que saiu dela (ou o que a tela tirou: `base`, os caminhos que ela mostrava).
   * Lista igual e nada tirado: a pasta fica como está (o Salvar do formulário não desfaz o que o agente mudou).
   */
  private placeFiles(before: Pick<IAgent, 'id' | 'projectId' | 'files'> | undefined, after: Pick<IAgent, 'id' | 'projectId' | 'files'>, base: readonly string[] = []): void {
    if (!this.files) return
    if (before && before.projectId !== after.projectId) this.files.moveAgent(after.id, before.projectId, after.projectId)
    const next = after.files ?? []
    const same = JSON.stringify(sortFiles(before?.files ?? [])) === JSON.stringify(sortFiles(next))
    if (same && !base.length) return
    const kept = new Set(next.map((file) => file.path))
    const removed = [...new Set([...(before?.files ?? []).map((file) => file.path), ...base])].filter((path) => !kept.has(path))
    this.files.writeAgent(after.id, after.projectId, next, removed)
  }

  /**
   * Só os triggers de um agente gravado (a ferramenta `agent_trigger`): o resto do agente fica como está, e só os
   * triggers passam pela regra. ⛔ Agente de fábrica (o Atlas, os construtores) não é gravado aqui: responde como inexistente.
   */
  saveTriggers(id: string, triggers: IAgentTrigger[], by: string): void {
    const stored = this.repository.list().find((agent) => agent.id === id)
    if (!stored) throw new AgentNotFoundError(id)
    const issues = triggerIssues(triggers)
    if (issues.length) throw new InvalidAgentError(issues)
    const agent: IAgent = { ...toAgent(stored) }
    delete agent.triggers
    this.repository.save(triggers.length ? { ...agent, triggers } : agent, by)
    // Quem grava aqui é a ferramenta `agent_trigger`, nunca a tela.
    this.history.record([{ kind: 'agent', id }], { by, source: 'agent' })
  }

  /**
   * Só as REGRAS DE PERMISSÃO de um agente gravado (o pedido de permissão: a restrição que vale já e a aprovação na
   * tela): o resto do agente fica como está, e só as regras passam pela regra (o mesmo validador do formulário).
   * `change`: por onde veio, a nota e as ampliações aceitas — vão na revisão. ⛔ Agente de fábrica responde inexistente.
   */
  savePermissions(id: string, rules: readonly IPermissionRule[], by: string, change: Omit<ICatalogChange, 'by'> = {}): IStoredAgent {
    const stored = this.repository.list().find((agent) => agent.id === id)
    if (!stored) throw new AgentNotFoundError(id)
    const issues = permissionIssues(rules)
    if (issues.length) throw new InvalidAgentError(issues)
    const clean = cleanRules(rules)
    const agent: IAgent = { ...toAgent(stored) }
    delete agent.permissions
    const saved = this.repository.save(clean.length ? { ...agent, permissions: clean } : agent, by)
    this.history.record([{ kind: 'agent', id }], { ...change, by })
    return saved
  }

  /**
   * Só os ARQUIVOS de um agente gravado (a guia Arquivos): o resto do agente fica como está. A lista passa pela regra
   * (caminho, tetos) e cada conteúdo tem de estar no depósito.
   */
  /** `base`: os caminhos que a tela mostrava (o que ela tirou é apagado, mesmo que o agente o tenha criado). */
  saveFiles(id: string, files: IResourceFile[], by: string, base: readonly string[] = []): IStoredAgent {
    const stored = this.repository.list().find((agent) => agent.id === id)
    if (!stored) throw new AgentNotFoundError(id)
    const issues = fileIssues(files)
    if (!issues.length && files.length) {
      if (!this.files) issues.push({ field: 'files', message: 'resource files are not available on this gateway' })
      else files.forEach((file, index) => !this.files!.has(file.sha256) && issues.push({ field: `files[${index}].sha256`, message: `content not uploaded: ${file.path}` }))
    }
    if (issues.length) throw new InvalidAgentError(issues)
    const before = toAgent(stored)
    const agent: IAgent = { ...before }
    delete agent.files
    const saved = this.repository.save(files.length ? { ...agent, files: sortFiles(files) } : agent, by)
    this.placeFiles(before, saved, base)
    this.history.record([{ kind: 'agent', id }], { by })
    return saved
  }

  /**
   * "Resolvido": tira do agente gravado os problemas da importação que casam (o código e, dado, o alvo). O resto do
   * agente fica como está, sem passar pela regra do salvamento (nada muda além da lista). Nenhum casou: 404.
   */
  resolveImportIssue(id: string, match: IImportProblemMatch, by: string): IStoredAgent {
    const stored = this.repository.list().find((agent) => agent.id === id)
    if (!stored) throw new AgentNotFoundError(id)
    const agent: IAgent = { ...toAgent(stored) }
    const rest = withoutProblem(agent.importIssues, match)
    if (!rest) throw new GuidanceNotFoundError('import issue', `${describeMatch(match)} in agent ${id}`)
    delete agent.importIssues
    const saved = this.repository.save(rest.length ? { ...agent, importIssues: rest } : agent, by)
    this.history.record([{ kind: 'agent', id }], { by })
    return saved
  }

  /** Muda o agente de projeto sem passar pela regra do salvamento — só a migração para projetos usa. */
  moveToProject(id: string, projectId: string, by: string): void {
    const stored = this.repository.list().find((agent) => agent.id === id)
    if (!stored) return
    const moved = this.repository.save({ ...toAgent(stored), projectId }, by)
    this.placeFiles(toAgent(stored), moved)
    this.history.record([{ kind: 'agent', id }], { by, source: 'migration' })
  }

  /**
   * ⛔ Não apaga agente que outro usa: um `agent:<id>` órfão travava todo salvamento do agente que delega,
   * e o padrão das configurações apagado fazia toda conversa sem agente escolhido falhar.
   */
  remove(id: string, by: string, options: { defaultAgentId?: string } = {}): void {
    const delegators = this.repository
      .list()
      .filter((agent) => agent.id !== id && agent.allowedTools.includes(`agent:${id}`))
      .map((agent) => agent.id)
    const isDefault = options.defaultAgentId === id
    if (delegators.length || isDefault) throw new AgentInUseError(id, delegators, isDefault)
    const stored = this.repository.list().find((agent) => agent.id === id)
    if (!this.repository.delete(id)) throw new AgentNotFoundError(id)
    if (stored) this.files?.remove('agent', id, stored.projectId)
    this.history.record([{ kind: 'agent', id }], { by })
  }
}

/** Só os campos do agente: datas e autoria são do registro, não do contrato. */
function toAgent(stored: IStoredAgent): IAgent {
  return {
    id: stored.id,
    name: stored.name,
    providers: stored.providers.map((target) => ({
      provider: target.provider,
      models: [...target.models],
      ...(target.sandbox ? { sandbox: target.sandbox } : {}),
      ...(target.network ? { network: true } : {}),
    })),
    systemPrompt: stored.systemPrompt,
    ...(stored.soul ? { soul: stored.soul } : {}),
    reasoningEfforts: stored.reasoningEfforts,
    modes: stored.modes,
    allowedTools: stored.allowedTools,
    ...(stored.role ? { role: stored.role } : {}),
    ...(stored.adminOnly ? { adminOnly: true } : {}),
    ...(stored.projectId ? { projectId: stored.projectId } : {}),
    ...(stored.tags?.length ? { tags: [...stored.tags] } : {}),
    ...(stored.permissions?.length ? { permissions: stored.permissions } : {}),
    ...(stored.terminal && (stored.terminal.timeoutSeconds || stored.terminal.maxOutputChars) ? { terminal: { ...stored.terminal } } : {}),
    ...(diagnosticsOn(stored.diagnostics) ? { diagnostics: { ...stored.diagnostics } } : {}),
    ...(stored.triggers?.length ? { triggers: stored.triggers.map((trigger) => ({ id: trigger.id, when: trigger.when, body: trigger.body })) } : {}),
    ...(stored.env && Object.keys(stored.env).length ? { env: { ...stored.env } } : {}),
    ...(stored.files?.length ? { files: stored.files.map((file) => ({ ...file })) } : {}),
    ...(stored.importIssues?.length ? { importIssues: stored.importIssues.map((issue) => ({ ...issue })) } : {}),
    ...(stored.modelGroup ? { modelGroup: stored.modelGroup } : {}),
  }
}
