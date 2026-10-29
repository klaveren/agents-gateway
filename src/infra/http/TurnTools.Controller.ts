import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TurnGrants, turnGrants } from '@infra/tools/Turn.Grants'
import { Request, Response } from 'express'

export const TURN_GRANT_HEADER = 'x-turn-grant'

/**
 * `POST /v1/turn-tools` — o terminal, os arquivos e as tarefas do GATEWAY para um CLI que só fala MCP (o Codex).
 *
 * ⛔ Quem decide o quê é a concessão do turno (`Turn.Grants`), pelo header `X-Turn-Grant`: as ferramentas e o contexto
 * vêm dela, nunca da requisição. Token desconhecido ou de turno que acabou: 404. Cada chamada passa pelas permissões e
 * pelo cerco do agente, como no `run_bash` de qualquer outro provedor.
 */
export class TurnToolsController {
  constructor(private readonly grants: TurnGrants = turnGrants()) {
    this.handle = this.handle.bind(this)
  }

  async handle(req: Request, res: Response): Promise<void> {
    const deny = (status: number, message: string) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null })
    if (req.method !== 'POST') return void deny(405, 'Method not allowed: stateless; use POST.')
    const header = req.headers[TURN_GRANT_HEADER]
    const grant = this.grants.get(typeof header === 'string' ? header : undefined)
    if (!grant) return void deny(404, 'Not found')

    const server = new Server({ name: 'gateway-turn-tools', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      // `antigravity/alwaysLoad`: o `agy` entrega a ferramenta direto ao modelo, em vez de ele ter que descobri-la.
      tools: grant.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, _meta: { 'antigravity/alwaysLoad': true } })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = grant.tools.find((candidate) => candidate.name === request.params.name)
      if (!tool) return { content: [{ type: 'text', text: `Tool not available to this agent: ${request.params.name}` }], isError: true }
      try {
        const outcome = await tool.execute(request.params.arguments ?? {}, grant.context)
        return { content: [{ type: 'text', text: outcome.result }], ...(outcome.status === 'error' ? { isError: true } : {}) }
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
      console.error('[turn-tools] Error:', error instanceof Error ? error.message : String(error))
      if (!res.headersSent) deny(500, 'Internal error')
    }
  }
}
