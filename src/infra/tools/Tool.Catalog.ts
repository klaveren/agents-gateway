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

  get mcpConnected(): boolean {
    return this.mcp.isConnected()
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
