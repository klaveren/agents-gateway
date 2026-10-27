import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IMcpServerConfig, isLaunchedMcp, MCP_ALL_TOOLS, mcpSelection, parseMcpToolRef } from '@domain/models/McpServer.Model'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { delegatesOf } from '@domain/models/Delegation.Model'
import { ILocalTool, IToolDefinition, IToolResult } from './Tool.Types'

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
}

/** O servidor do `CALLER_PROOF_TOOL` quando o nome vem solto (o semeado de `MCP_SERVER_URL`). */
export const DEFAULT_MCP_SERVER = 'default'

/**
 * A visão de "que ferramentas existem": as LOCAIS (em processo) e as dos servidores MCP cadastrados.
 *
 * ⛔ UM AGENTE SÓ VÊ O QUE ESCOLHEU: locais pelo nome, MCP por `mcp:<servidor>/<ferramenta>` ou
 * `mcp:<servidor>/*` (ver `toolbox`). Antes dos servidores virarem cadastro, toda ferramenta do MCP
 * passava para todo agente.
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
  ) {}

  /** Algum servidor MCP ligado está conectado agora (para health e relatório). */
  get mcpConnected(): boolean {
    return this.mcp.status().some((server) => server.connected)
  }

  /** Os nomes de todas as tools locais deste processo. */
  localNames(): string[] {
    return this.local.map((tool) => tool.name)
  }

  /** As locais que o agente escolheu — e, se ele pode delegar (`agent:<id>`), a `delegate_to_agent` dele. */
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
    const remote: Array<{ server: string; tool: IToolDefinition }> = []

    for (const [server, choice] of mcpSelection(allowed)) {
      // Contêiner: a instância DESTA conversa (o `sessionId` do contexto); sem conversa, não há instância.
      const tools = await this.mcp.tools(server, context?.sessionId).catch(() => [])
      for (const tool of tools) if (choice.all || choice.tools.has(tool.name)) remote.push({ server, tool })
    }

    const counts = new Map<string, number>()
    for (const name of [...local.map((tool) => tool.name), ...remote.map(({ tool }) => tool.name)]) counts.set(name, (counts.get(name) ?? 0) + 1)
    const routes = new Map<string, { server: string; tool: string }>()
    const exposed = remote.map(({ server, tool }) => {
      const name = counts.get(tool.name) === 1 ? tool.name : `${server}__${tool.name}`.slice(0, 64)
      routes.set(name, { server, tool: tool.name })
      return { ...tool, name, origin: 'mcp' as const }
    })

    return {
      tools: [...local, ...exposed],
      invoke: async (name, args, context) => {
        const own = local.find((tool) => tool.name === name)
        if (own) return own.execute(args, context)
        const route = routes.get(name)
        if (!route) return { status: 'error', result: `Tool not available to this agent: ${name}` }
        return this.callMcp(route.server, route.tool, args, context)
      },
    }
  }

  /** O servidor de um contêiner ou processo, visto por um SDK agêntico: o proxy do gateway, preso à conversa. */
  private viaProxy(config: IMcpServerConfig): IMcpServerConfig | undefined {
    if (!this.containerProxy) return undefined
    return { ...config, kind: 'remote', url: `${this.containerProxy.base}/${config.id}`, transport: 'http', auth: 'caller', headerName: 'X-Tool-Authorization' }
  }

  /** Os servidores MCP que um agente escolheu e que estão de pé agora — os SDKs agênticos conectam neles. */
  async mcpServersFor(allowed: readonly string[], context?: IExecutionContext): Promise<IAgentMcpServer[]> {
    const servers: IAgentMcpServer[] = []
    for (const [id, choice] of mcpSelection(allowed)) {
      const stored = this.mcp.get(id)
      if (stored && isLaunchedMcp(stored)) {
        const proxied = stored.enabled && context?.sessionId ? this.viaProxy(stored) : undefined
        if (!proxied || !context?.sessionId) continue
        servers.push({
          config: proxied,
          ...(choice.all ? {} : { tools: [...choice.tools] }),
          callerHeader: 'X-Tool-Authorization',
          fixed: { 'X-Gateway-Session': context.sessionId },
        })
        continue
      }
      const client = await this.mcp.connected(id)
      const config = stored
      if (!client || !config) continue
      const fixed = this.mcp.fixedHeaders(config)
      servers.push({
        config,
        ...(choice.all ? {} : { tools: [...choice.tools] }),
        ...(config.auth === 'header' ? { header: this.mcp.header(id) } : {}),
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
    return this.callMcp(ref.server, ref.tool, args, context)
  }

  private async callMcp(server: string, tool: string, args: Record<string, unknown>, context?: IExecutionContext): Promise<IToolResult> {
    let client
    try {
      client = await this.mcp.clientFor(server, context?.sessionId)
    } catch (error: unknown) {
      return { status: 'error', result: error instanceof Error ? error.message : String(error) }
    }
    if (!client) return { status: 'error', result: `MCP server unavailable: ${server}` }
    return client.callTool(tool, args, context)
  }
}
