import { McpServerClient } from '@infra/mcp/McpServer.Client'
import { ILocalTool, IToolDefinition, IToolResult } from './Tool.Types'

/**
 * A visão única de "que tools existem", unindo o MCP server (quando conectado) com o
 * toolset local embutido.
 *
 * `allowedTools` do registry filtra as tools **locais**, que são um conjunto fixo e
 * conhecido. Tools vindas do MCP passam todas: quem escolheu subir aquele server foi o
 * operador, e barrar descoberta dinâmica tiraria a graça do MCP.
 */
export class ToolCatalog {
  constructor(
    private readonly mcp: McpServerClient,
    private readonly local: ILocalTool[],
  ) {}

  get mcpUrl(): string {
    return this.mcp.serverUrl
  }

  /** Status síncrono, para health e relatório. Não tenta reconectar. */
  get mcpConnected(): boolean {
    return this.mcp.isConnected()
  }

  /** Muda a cada reconexão; quem cacheia recurso derivado compara para saber que expirou. */
  get mcpGeneration(): number {
    return this.mcp.connectionGeneration
  }

  /**
   * A URL do MCP se ele estiver utilizável — reconectando se necessário e se a janela de
   * backoff já passou.
   *
   * É isto que os adapters usam para decidir se ligam o MCP nativo do SDK. Usar o getter
   * síncrono aqui congelava a decisão do boot: server que subisse depois nunca aparecia.
   */
  async mcpEndpoint(): Promise<string | undefined> {
    return (await this.mcp.ensureConnected()) ? this.mcp.serverUrl : undefined
  }

  localFor(allowed: string[]): ILocalTool[] {
    return this.local.filter((tool) => allowed.includes(tool.name))
  }

  /** Catálogo completo para relatório e health. Uma tool local sombreia a homônima do MCP. */
  async list(allowed: string[]): Promise<IToolDefinition[]> {
    const local = this.localFor(allowed)
    const names = new Set(local.map((tool) => tool.name))
    const remote = (await this.mcp.listTools()).filter((tool) => !names.has(tool.name))

    return [...local, ...remote]
  }

  /**
   * Caminho de execução do gateway. Na lane `agent` quem executa é o próprio Agents SDK;
   * isto serve para diagnóstico e para qualquer chamador que não seja um SDK agêntico.
   */
  async invoke(name: string, args: Record<string, unknown>): Promise<IToolResult> {
    const tool = this.local.find((candidate) => candidate.name === name)
    if (tool) return tool.execute(args)

    return this.mcp.callTool(name, args)
  }
}
