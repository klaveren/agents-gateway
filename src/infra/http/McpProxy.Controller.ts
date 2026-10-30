import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mcpSelection, mcpServesProject } from '@domain/models/McpServer.Model'
import { ISession } from '@domain/models/Session.Model'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { Request, Response } from 'express'
import { ownsSession, resolveCaller } from './Caller.Access'
import { ICallerProof } from './Caller.Proof'

export const GATEWAY_SESSION_HEADER = 'x-gateway-session'

export interface IMcpProxyDeps {
  registry: McpRegistry
  proof?: ICallerProof
  /** A sessão viva (do provider). `undefined` = não existe mais. */
  session: (sessionId: string) => Pick<ISession, 'agentId' | 'metadata'> | undefined
  /** O agente como gravado: as escolhas (`allowedTools`) e o projeto dele (ausente = global). */
  agent: (agentId: string) => { allowedTools: readonly string[]; projectId?: string } | undefined
}

/**
 * `POST /v1/mcp-proxy/:serverId` — a ponte dos SDKs agênticos (Claude e OpenAI) até um MCP em CONTÊINER.
 *
 * ⚖️ Esses SDKs conectam a MCPs por conta própria e não sabem de contêiner nem de conversa. Aqui o gateway
 * recebe a conexão, descobre DE QUE CONVERSA ela é (`X-Gateway-Session`) e encaminha `tools/list` e
 * `tools/call` à instância daquela conversa — com o esquema inteiro e a resposta inteira (imagens inclusas).
 *
 * ⛔ QUATRO CONFERÊNCIAS: a conversa é de quem chama (a mesma regra de dono das rotas — de outro, 404); o
 * servidor (`:serverId` é a CHAVE, ver `mcpServerKey`) serve ao projeto do agente da conversa — o de outro projeto é
 * 404; o agente escolheu este servidor; e, se escolheu só algumas ferramentas, só elas existem.
 */
export class McpProxyController {
  constructor(private readonly deps: IMcpProxyDeps) {
    this.handle = this.handle.bind(this)
  }

  async handle(req: Request, res: Response): Promise<void> {
    const deny = (status: number, message: string) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null })
    if (req.method !== 'POST') return void deny(405, 'Method not allowed: stateless; use POST.')

    const serverId = req.params.serverId as string
    const sessionId = req.headers[GATEWAY_SESSION_HEADER]
    if (typeof sessionId !== 'string' || !sessionId) return void deny(400, 'Missing X-Gateway-Session')

    const resolved = await resolveCaller(this.deps.proof)
    const session = this.deps.session(sessionId)
    if (!resolved || !session || !ownsSession(resolved, session.metadata)) return void deny(404, 'Not found')

    const agent = this.deps.agent(session.agentId)
    const config = this.deps.registry.get(serverId)
    if (!agent || !config || !mcpServesProject(config, agent.projectId)) return void deny(404, 'Not found')
    const choice = mcpSelection(agent.allowedTools).get(config.id)
    if (!choice) return void deny(404, 'Not found')
    const allowed = (name: string) => choice.all || choice.tools.has(name)

    const server = new Server({ name: `gateway-proxy-${serverId}`, version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const client = await this.deps.registry.clientFor(serverId, sessionId)
      const tools = ((await client?.listToolsRaw()) ?? []).filter((tool) => allowed(String(tool.name)))
      return { tools } as never
    })
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!allowed(request.params.name)) return { content: [{ type: 'text', text: `Tool not available to this agent: ${request.params.name}` }], isError: true }
      try {
        const client = await this.deps.registry.clientFor(serverId, sessionId)
        if (!client) return { content: [{ type: 'text', text: `MCP server unavailable: ${serverId}` }], isError: true }
        return (await client.callToolRaw(request.params.name, request.params.arguments ?? {})) as never
      } catch (error: unknown) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
      }
    })

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error: unknown) {
      console.error('[mcp-proxy] Error:', error instanceof Error ? error.message : String(error))
      if (!res.headersSent) deny(500, 'Internal error')
    }
  }
}
