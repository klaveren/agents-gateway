import { IMPORT_TOOLS, PROPOSE_DRAFT_TOOL } from '@domain/Builder.Agents'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IMcpServerConfig, isLaunchedMcp, MCP_ALL_TOOLS, mcpSelection, mcpServerKey, mcpServesProject, parseMcpToolRef } from '@domain/models/McpServer.Model'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { delegatesOf, PEOPLE_ONLY_GATEWAY_TOOLS } from '@domain/models/Delegation.Model'
import { SELF_MCP_SERVER_ID } from '@application/McpServers.Service'
import { LEDGER_TOOLS } from '@domain/models/Ledger.Model'
import { ILocalTool, IToolDefinition, IToolResult } from './Tool.Types'
import type { IPermissionChecker } from '@application/Permissions.Service'
import type { IPermissionVerdict } from '@domain/Permission.Policy'
import { askerOf } from './Local.Tools'

/** Quem executa uma ferramenta pelo nome com que o modelo a pediu. */
export interface IToolInvoker {
  invoke(name: string, args: Record<string, unknown>, context?: IExecutionContext): Promise<IToolResult>
}

/** As ferramentas de UM agente, com os nomes que o modelo vê, e como executá-las. */
export interface IToolbox extends IToolInvoker {
  tools: IToolDefinition[]
}

/** Um servidor MCP escolhido por um agente, para os SDKs agênticos que conectam por conta própria. */
export interface IAgentMcpServer {
  config: IMcpServerConfig
  /** `undefined` = todas as ferramentas (`mcp:<id>/*`); senão, só estas. */
  tools?: string[]
  /** O header fixo (`auth: header`). `caller` usa a credencial da chamada; `none`, nada. */
  header?: { name: string; value: string }
  /** Em que header vai a credencial de `auth: caller` (padrão `authorization`). */
  callerHeader?: string
  /** Headers de toda requisição, além da credencial (ex.: o portão do próprio gateway). */
  fixed?: Record<string, string>
  /**
   * As ferramentas do servidor FORA da escolha (com `tools`): o SDK que conecta por conta própria lista o servidor
   * inteiro, e estas saem do contexto do modelo. Ausente = não se soube listar (o portão ainda recusa).
   */
  hidden?: string[]
}

/** O servidor do `CALLER_PROOF_TOOL` quando o nome vem solto (o semeado de `MCP_SERVER_URL`). */
export const DEFAULT_MCP_SERVER = 'default'

/**
 * A visão de "que ferramentas existem": as LOCAIS (em processo) e as dos servidores MCP cadastrados.
 *
 * ⛔ UM AGENTE SÓ VÊ O QUE ESCOLHEU: locais pelo nome, MCP por `mcp:<servidor>/<ferramenta>` ou
 * `mcp:<servidor>/*` (ver `toolbox`). Antes dos servidores virarem cadastro, toda ferramenta do MCP
 * passava para todo agente.
 *
 * ⛔ E SÓ DO ESCOPO DELE: o `<servidor>` é resolvido com o projeto do agente (`context.projectId`) — o global ou o do
 * projeto dele, nunca o de outro projeto, em toda lane (`toolbox`, `mcpServersFor`, `invoke`). É a segunda trava:
 * a primeira é o cadastro do agente, que recusa `mcp:` fora do escopo. Sem contexto, só os globais.
 */
export class ToolCatalog {
  constructor(
    readonly mcp: McpRegistry,
    private readonly local: ILocalTool[],
    /** A ferramenta de delegação de um agente (os `agent:<id>` dele). Ausente = sem delegação. */
    private readonly delegation?: (allowed: readonly string[]) => ILocalTool,
    /**
     * O proxy MCP do próprio gateway (`/v1/mcp-proxy/<id>`), por onde os SDKs agênticos chegam aos MCPs em
     * contêiner — eles nunca falam com o Docker. Ausente = contêiner só nas lanes que usam a caixa.
     */
    private readonly containerProxy?: { base: string },
    /** As permissões dos agentes: ferramenta de MCP negada nem aparece para o modelo, e a chamada é recusada de novo. */
    private readonly permissions?: IPermissionChecker,
  ) {}

  /** A ferramenta `servidor/ferramenta` pode ser usada por quem pede? Sem permissões configuradas, pode. */
  private mcpAllowed(server: string, tool: string, context: IExecutionContext | undefined, log = false): IPermissionVerdict | undefined {
    if (!this.permissions) return undefined
    return this.permissions.check(askerOf(context), { category: 'mcp', value: `${server}/${tool}` }, { log })
  }

  /** Algum servidor MCP ligado está conectado agora (para health e relatório). */
  get mcpConnected(): boolean {
    return this.mcp.status().some((server) => server.connected)
  }

  /** Os nomes de todas as tools locais deste processo. */
  /**
   * As locais que um agente do catálogo pode escolher. ⛔ Sem as do construtor (e as do modo importação): são só dos agentes
   * do core. Sem as do ledger: todo agente já as tem (ver `AgentProvider.withDocs`), não são escolha.
   */
  localNames(): string[] {
    return this.local.map((tool) => tool.name).filter((name) => name !== PROPOSE_DRAFT_TOOL && !IMPORT_TOOLS.includes(name) && !LEDGER_TOOLS.includes(name))
  }

  /** As locais que o agente escolheu — e, se ele pode delegar (`agent:<id>`), o `talk` dele. */
  localFor(allowed: readonly string[]): ILocalTool[] {
    const tools = this.local.filter((tool) => allowed.includes(tool.name))
    const delegates = delegatesOf(allowed)
    return delegates.length && this.delegation ? [...tools, this.delegation(delegates)] : tools
  }

  /** As tools LOCAIS permitidas (as de MCP vêm por servidor, em `/mcp-servers`). */
  async list(allowed: readonly string[]): Promise<IToolDefinition[]> {
    return this.localFor(allowed)
  }

  /**
   * As ferramentas de um agente, prontas para o loop manual (lanes chat) e para o ADK.
   *
   * ⚖️ O NOME QUE O MODELO VÊ é o da ferramenta quando ele é único na caixa; com dois servidores
   * oferecendo o mesmo nome (ou um deles igual ao de uma local), vira `<servidor>__<ferramenta>`. A
   * local vence sempre: é a que tem a política do gateway (run_bash, timeouts).
   */
  async toolbox(allowed: readonly string[], context?: IExecutionContext): Promise<IToolbox> {
    const local = this.localFor(allowed)
    const remote: Array<{ server: string; key: string; tool: IToolDefinition }> = []
    const scope = mcpScopeOf(context)

    for (const [server, choice] of mcpSelection(allowed)) {
      const config = this.mcp.resolve(server, scope)
      if (!config) continue
      const key = mcpServerKey(config)
      // Contêiner: a instância DESTA conversa (o `sessionId` do contexto); sem conversa, não há instância.
      // A credencial de quem conversa: um MCP `caller` (o do próprio gateway) recusa até a listagem sem ela.
      const tools = agentFacing(server, await this.mcp.tools(key, context?.sessionId, context?.token).catch(() => []))
      for (const tool of tools)
        if ((choice.all || choice.tools.has(tool.name)) && this.mcpAllowed(server, tool.name, context)?.allowed !== false) remote.push({ server, key, tool })
    }

    const counts = new Map<string, number>()
    for (const name of [...local.map((tool) => tool.name), ...remote.map(({ tool }) => tool.name)]) counts.set(name, (counts.get(name) ?? 0) + 1)
    const routes = new Map<string, { server: string; key: string; tool: string }>()
    const exposed = remote.map(({ server, key, tool }) => {
      const name = counts.get(tool.name) === 1 ? tool.name : `${server}__${tool.name}`.slice(0, 64)
      routes.set(name, { server, key, tool: tool.name })
      return { ...tool, name, origin: 'mcp' as const }
    })

    return {
      tools: [...local, ...exposed],
      invoke: async (name, args, context) => {
        const own = local.find((tool) => tool.name === name)
        if (own) return own.execute(args, context)
        const route = routes.get(name)
        if (!route) return { status: 'error', result: `Tool not available to this agent: ${name}` }
        // ⛔ De novo na chamada: o modelo pode chamar um nome que não estava na lista.
        const verdict = this.mcpAllowed(route.server, route.tool, context, true)
        if (verdict && !verdict.allowed) return { status: 'error', result: `Not permitted: ${verdict.reason}` }
        // O escopo é o do agente desta caixa (a do turno), não o que vier na chamada.
        return this.callMcp(route.key, route.tool, args, context, scope)
      },
    }
  }

  /** O servidor de um contêiner ou processo, visto por um SDK agêntico: o proxy do gateway, preso à conversa. */
  private viaProxy(config: IMcpServerConfig): IMcpServerConfig | undefined {
    if (!this.containerProxy) return undefined
    // Pela CHAVE: o proxy confere de novo que o agente da conversa enxerga este servidor.
    return { ...config, kind: 'remote', url: `${this.containerProxy.base}/${mcpServerKey(config)}`, transport: 'http', auth: 'caller', headerName: 'X-Tool-Authorization' }
  }

  /**
   * O servidor remoto levaria credencial no header de um SDK que conecta por conta própria (e não é o do próprio gateway)?
   * ⚖️ O `oauth` também: o token é da pessoa e só o gateway o tem (e renova). Conectando sozinho, o SDK leva 401 e tenta
   * o registro dinâmico de cliente, que o Google recusa ("does not support dynamic client registration").
   */
  private leavesCredentialInArgv(config: IMcpServerConfig, fixed: Record<string, string> | undefined): boolean {
    if (!this.containerProxy) return false
    if (config.id === SELF_MCP_SERVER_ID && !config.projectId) return false
    return config.auth === 'caller' || config.auth === 'header' || config.auth === 'oauth' || !!(fixed && Object.keys(fixed).length)
  }

  /**
   * O que o SDK que conecta por conta própria pode usar do servidor: a escolha do agente MENOS o que as permissões negam
   * (`tools` ausente = todas). ⛔ Com permissões e sem conseguir listar o servidor: só a escolha explícita, nome a nome pelas
   * permissões; "todas" fica sem nenhuma (falha fechada).
   */
  private async visibleOf(
    id: string,
    key: string,
    choice: { all: boolean; tools: ReadonlySet<string> },
    context?: IExecutionContext,
  ): Promise<{ tools?: string[]; hidden: string[] }> {
    if (!this.permissions) {
      const blocked = id === SELF_MCP_SERVER_ID ? [...PEOPLE_ONLY_GATEWAY_TOOLS] : []
      if (choice.all) return { hidden: blocked }
      return { tools: [...choice.tools].filter((name) => !blocked.includes(name)), hidden: [...new Set([...(await this.hiddenOf(key, choice.tools, context)), ...blocked])] }
    }
    const listed = await this.mcp.tools(key, context?.sessionId, context?.token).catch(() => [])
    // ⚠️ A listagem falhou (um `socket hang up` do agents-mcp, 07/11 10:40): o servidor subia sem nada liberado, o CLI via as
    // ferramentas pela conexão dele e o portão recusou toda chamada da Vera por 47 min ("not enabled for this agent").
    // A escolha EXPLÍCITA do agente, cada nome pelas permissões, segue valendo; "todas" sem a lista fica fechada.
    if (!listed.length) {
      if (choice.all) return { tools: [], hidden: [] }
      const chosen = agentFacing(
        id,
        [...choice.tools].map((name) => ({ name })),
      ).map((tool) => tool.name)
      return { tools: chosen.filter((name) => this.mcpAllowed(id, name, context)?.allowed !== false), hidden: [] }
    }
    const facing = new Set(agentFacing(id, listed).map((tool) => tool.name))
    const names = listed.map((tool) => tool.name)
    const tools = names.filter((name) => facing.has(name) && (choice.all || choice.tools.has(name)) && this.mcpAllowed(id, name, context)?.allowed !== false)
    return { tools, hidden: names.filter((name) => !tools.includes(name)) }
  }

  /** As ferramentas do servidor que ficaram fora da escolha. Sem conseguir listar, nenhuma (o portão segue recusando). */
  private async hiddenOf(key: string, chosen: ReadonlySet<string>, context?: IExecutionContext): Promise<string[]> {
    const tools = await this.mcp.tools(key, context?.sessionId, context?.token).catch(() => [])
    return tools.map((tool) => tool.name).filter((name) => !chosen.has(name))
  }

  /** Os servidores MCP que um agente escolheu e que estão de pé agora — os SDKs agênticos conectam neles. */
  async mcpServersFor(allowed: readonly string[], context?: IExecutionContext): Promise<IAgentMcpServer[]> {
    const servers: IAgentMcpServer[] = []
    for (const [id, choice] of mcpSelection(allowed)) {
      // ⛔ Só o do escopo do agente: config, URL e credencial de servidor de outro projeto nunca chegam ao SDK.
      const stored = this.mcp.resolve(id, mcpScopeOf(context))
      if (!stored) continue
      const key = mcpServerKey(stored)
      if (isLaunchedMcp(stored)) {
        const proxied = stored.enabled && context?.sessionId ? this.viaProxy(stored) : undefined
        if (!proxied || !context?.sessionId) continue
        const { tools, hidden } = await this.visibleOf(id, key, choice, context)
        servers.push({
          config: proxied,
          ...(tools ? { tools } : {}),
          ...(hidden.length ? { hidden } : {}),
          callerHeader: 'X-Tool-Authorization',
          fixed: { 'X-Gateway-Session': context.sessionId },
        })
        continue
      }
      const client = await this.mcp.connected(key, undefined, context?.token)
      const config = stored
      if (!client) continue
      const fixed = this.mcp.fixedHeaders(config)
      const { tools, hidden } = await this.visibleOf(id, key, choice, context)
      // ⛔ REMOTO EXTERNO que leva credencial (`caller`, `header` ou headers fixos): o CLI do Claude e do Codex conecta por
      // conta própria e deixaria o token de quem conversa / o segredo do cadastro no argv do processo filho. Vai pela ponte
      // do gateway, que guarda a credencial e conecta por dentro. O do próprio gateway já leva só a concessão do turno.
      const viaBridge = this.leavesCredentialInArgv(config, fixed) && context?.sessionId ? this.viaProxy(config) : undefined
      if (viaBridge && context?.sessionId) {
        servers.push({
          config: viaBridge,
          ...(tools ? { tools } : {}),
          ...(hidden.length ? { hidden } : {}),
          callerHeader: 'X-Tool-Authorization',
          fixed: { 'X-Gateway-Session': context.sessionId },
        })
        continue
      }
      servers.push({
        config,
        ...(tools ? { tools } : {}),
        ...(hidden.length ? { hidden } : {}),
        ...(config.auth === 'header' ? { header: this.mcp.header(key) } : {}),
        ...(config.auth === 'caller' && config.headerName ? { callerHeader: config.headerName } : {}),
        ...(fixed ? { fixed } : {}),
      })
    }
    return servers
  }

  /**
   * Executa uma ferramenta pelo nome: local, `servidor/ferramenta`, ou — nome solto que não é local — a
   * do servidor `default`. É o caminho do `CALLER_PROOF_TOOL` e de diagnóstico.
   */
  async invoke(name: string, args: Record<string, unknown>, context?: IExecutionContext): Promise<IToolResult> {
    const tool = this.local.find((candidate) => candidate.name === name)
    if (tool) return tool.execute(args, context)

    const ref = parseMcpToolRef(name.startsWith('mcp:') ? name : `mcp:${name.includes('/') ? name : `${DEFAULT_MCP_SERVER}/${name}`}`)
    if (!ref || ref.tool === MCP_ALL_TOOLS) return { status: 'error', result: `Unknown tool: ${name}` }
    const config = this.mcp.resolve(ref.server, mcpScopeOf(context))
    if (!config) return { status: 'error', result: `MCP server unavailable: ${ref.server}` }
    return this.callMcp(mcpServerKey(config), ref.tool, args, context, mcpScopeOf(context))
  }

  private mask?: (text: string, sessionId?: string) => string

  /** ⛔ A máscara de segredos no resultado das ferramentas de MCP que passam pelo gateway (ver `Secret.Mask`). */
  useMask(mask: (text: string, sessionId?: string) => string): void {
    this.mask = mask
  }

  /** `key`: a chave do servidor, já resolvida; `scope`: o projeto do agente — conferido de novo aqui. */
  private async callMcp(key: string, tool: string, args: Record<string, unknown>, context: IExecutionContext | undefined, scope: string | undefined): Promise<IToolResult> {
    const outcome = await this.callMcpRaw(key, tool, args, context, scope)
    return this.mask ? { ...outcome, result: this.mask(outcome.result, context?.sessionId) } : outcome
  }

  private async callMcpRaw(key: string, tool: string, args: Record<string, unknown>, context: IExecutionContext | undefined, scope: string | undefined): Promise<IToolResult> {
    const config = this.mcp.get(key)
    // ⛔ Defesa em profundidade: o servidor pode ter mudado de projeto depois que a caixa foi montada.
    if (!config || !mcpServesProject(config, scope)) return { status: 'error', result: `MCP server unavailable: ${config?.id ?? key}` }
    let client
    try {
      client = await this.mcp.clientFor(key, context?.sessionId)
    } catch (error: unknown) {
      return { status: 'error', result: error instanceof Error ? error.message : String(error) }
    }
    if (!client) return { status: 'error', result: `MCP server unavailable: ${config.id}` }
    return client.callTool(tool, args, context)
  }
}

/** O escopo dos MCPs: o projeto do agente; o global, o da conversa (ver `IExecutionContext.mcpProjectId`). */
const mcpScopeOf = (context: IExecutionContext | undefined): string | undefined => context?.projectId ?? context?.mcpProjectId

/** ⛔ O que um agente vê de um servidor: do MCP do gateway, nunca as ferramentas de conversa (ver `PEOPLE_ONLY_GATEWAY_TOOLS`). */
function agentFacing<T extends { name: string }>(server: string, tools: readonly T[]): T[] {
  return server === SELF_MCP_SERVER_ID ? tools.filter((tool) => !PEOPLE_ONLY_GATEWAY_TOOLS.includes(tool.name)) : [...tools]
}
