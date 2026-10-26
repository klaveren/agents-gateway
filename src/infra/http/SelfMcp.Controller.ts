import { dangerousToolsOf } from '@domain/Tool.Policy'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Request, Response } from 'express'
import { z } from 'zod'

/** O que a própria API devolveu: o envelope `{ ok, result, message, code, details }` mais o status. */
interface ISelfReply {
  ok: boolean
  status: number
  result?: unknown
  message?: string
  code?: string
  details?: unknown
}

type TSelfApi = (method: string, path: string, options?: { body?: unknown; query?: Record<string, string | number | undefined> }) => Promise<ISelfReply>

/**
 * A API do gateway chamada DE DENTRO dele, com os headers de quem chamou o MCP.
 *
 * ⚖️ AS REGRAS MORAM NOS CONTROLLERS — dono da conversa, audiência, carimbo do `owner`, DTO sem prompt e sem
 * custo para quem não administra. Passar pela API é o que garante que o MCP segue as MESMAS regras, sem uma
 * segunda cópia que um dia divergiria. O preço é um salto local por ferramenta.
 *
 * ⛔ Só o header da credencial (`X-Tool-Authorization`, a conta) segue adiante. Nada do corpo do MCP vira
 * identidade.
 */
function selfApi(req: Request): TSelfApi {
  const address = req.socket.localAddress?.replace(/^::ffff:/, '') || '127.0.0.1'
  const base = `http://${address.includes(':') ? `[${address}]` : address}:${req.socket.localPort}/v1`
  const credentials: Record<string, string> = {}
  for (const name of ['x-tool-authorization']) {
    const value = req.headers[name]
    if (typeof value === 'string') credentials[name] = value
  }

  return async (method, path, options = {}) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== '') query.set(key, String(value))
    const url = `${base}${path}${query.size ? `?${query}` : ''}`

    const response = await fetch(url, {
      method,
      headers: { ...credentials, Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const envelope = (await response.json().catch(() => ({}))) as Omit<ISelfReply, 'status'>
    return { ...envelope, ok: response.ok && envelope.ok !== false, status: response.status }
  }
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

/** O erro da API vira resultado de ferramenta com `isError` — o cliente vê a mensagem; nada lança. */
function reply(answer: ISelfReply, pick: (result: unknown) => unknown = (result) => result) {
  if (answer.ok) return text(pick(answer.result))
  return { ...text({ status: answer.status, code: answer.code, message: answer.message, details: answer.details }), isError: true }
}

/** Só os itens com `enabled: true` (e o que mais `keep` exigir). */
function enabledOnly(result: unknown, keep: (item: Record<string, unknown>) => boolean = () => true): unknown {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>).filter((item) => item.enabled === true && keep(item)) : result
}

/** O turno agregado, sem o que só a tela usa. */
function turnView(result: unknown) {
  const turn = (result ?? {}) as Record<string, unknown>
  return {
    text: turn.text,
    toolCalls: Array.isArray(turn.toolCalls) ? (turn.toolCalls as Array<{ tool?: string; error?: string }>).map((call) => ({ tool: call.tool, error: call.error })) : undefined,
    usage: turn.usage,
    warnings: turn.warnings,
    error: turn.error,
    aborted: turn.aborted,
  }
}

const agentShape = {
  id: z.string().describe('2–48 lowercase letters, digits or hyphens.'),
  name: z.string(),
  soul: z.string().optional().describe('Who the agent is: identity, tone, values, way of speaking. The system prompt says what it does.'),
  provider: z.string().describe('A configured provider id (claude, openai, google or a compatible one).'),
  systemPrompt: z.string(),
  models: z.array(z.string()).describe('Models ENABLED in that provider catalog; the first is the default.'),
  reasoningEfforts: z.array(z.string()).optional(),
  modes: z.array(z.enum(['chat', 'agent'])),
  allowedTools: z.array(z.string()).default([]).describe('Local names, `sdk:…` natives and `mcp:<server>/<tool>`; see list_tools.'),
  role: z
    .enum(['subagent'])
    .nullable()
    .optional()
    .describe('`subagent`: only called by another agent through delegation (`agent:<id>`), never in a direct conversation. `null` makes it a regular agent.'),
}

/**
 * As ferramentas, segundo quem chama.
 *
 * ⛔ Ferramenta de admin NEM É REGISTRADA para quem não administra, e as de escrita só existem com
 * `SELF_MCP_WRITE=0` desligando — o cliente não vê o que não pode usar. A API, por baixo, recusaria de qualquer jeito.
 * ⛔ Chave de API e senha não passam por aqui: não há ferramenta para elas.
 */
function registerTools(server: McpServer, api: TSelfApi, access: { admin: boolean; write: boolean }) {
  server.registerTool(
    'list_agents',
    {
      description:
        'List the agents: provider, models (with price), reasoning levels per model, lanes and tools. Never includes the system prompt. Agents with `role: subagent` are only called by other agents and cannot start a conversation.',
      annotations: { readOnlyHint: true },
    },
    async () => reply(await api('GET', '/agents')),
  )

  server.registerTool(
    'start_conversation',
    {
      description:
        'Open a conversation with an agent. With `message`, also sends the first message and returns the reply. `metadata` is stored with the conversation (e.g. { accountId, userId }) for billing and filtering.',
      inputSchema: {
        agentId: z.string(),
        mode: z.enum(['chat', 'agent']).optional().describe('chat = plain SDK; agent = the provider Agents SDK.'),
        model: z.string().optional(),
        reasoning: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        message: z.string().optional(),
      },
    },
    async ({ message, ...body }) => {
      const created = await api('POST', '/sessions', { body })
      if (!created.ok || !message) return reply(created)
      const sessionId = (created.result as { id: string }).id
      const turn = await api('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { body: { message } })
      return turn.ok ? text({ sessionId, ...turnView(turn.result) }) : reply(turn)
    },
  )

  server.registerTool(
    'send_message',
    { description: 'Send a message in a live conversation and wait for the full reply.', inputSchema: { sessionId: z.string(), message: z.string() } },
    async ({ sessionId, message }) => reply(await api('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { body: { message } }), turnView),
  )

  server.registerTool(
    'switch_model',
    {
      description: 'Switch the model and/or the reasoning level of a live conversation, from the next message on. Same provider only; `reasoning: null` = provider default.',
      inputSchema: { sessionId: z.string(), model: z.string().optional(), reasoning: z.string().nullable().optional() },
    },
    async ({ sessionId, ...change }) => reply(await api('PATCH', `/sessions/${encodeURIComponent(sessionId)}`, { body: change })),
  )

  server.registerTool(
    'list_conversations',
    {
      description: 'List conversations (yours; an administrator sees all). `metadata` filters by stored metadata keys, e.g. { accountId: "xpto" }.',
      inputSchema: { q: z.string().optional(), metadata: z.record(z.string(), z.string()).optional(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ q, metadata, limit }) =>
      reply(await api('GET', '/conversations', { query: { ...metadata, q, limit } }), (result) =>
        ((result as { sessions?: Array<Record<string, unknown>> }).sessions ?? []).map((session) => ({
          id: session.id,
          title: session.title,
          agentId: session.agentId,
          model: session.model,
          turns: session.turns,
          updatedAt: session.updatedAt,
          usage: session.usage,
          ...(session.costUsd === undefined ? {} : { costUsd: session.costUsd }),
        })),
      ),
  )

  server.registerTool(
    'get_conversation',
    { description: 'Read the turns of a conversation (yours, or any if you administer).', inputSchema: { sessionId: z.string() }, annotations: { readOnlyHint: true } },
    async ({ sessionId }) =>
      reply(await api('GET', `/conversations/${encodeURIComponent(sessionId)}/turns`), (result) =>
        ((result as { turns?: Array<Record<string, unknown>> }).turns ?? []).map((turn) => ({
          index: turn.index,
          at: turn.at,
          request: turn.request,
          text: turn.text,
          model: turn.model,
          effort: turn.effort,
          usage: turn.usage,
          tools: Array.isArray(turn.toolCalls) ? (turn.toolCalls as Array<{ tool?: string }>).map((call) => call.tool) : undefined,
          ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
        })),
      ),
  )

  server.registerTool(
    'my_usage',
    {
      description: 'Your own token usage (per day, agent and model). Requires a signed-in account; never carries cost.',
      inputSchema: { days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => reply(await api('GET', '/usage/me', { query: { days } })),
  )

  if (!access.admin) return

  server.registerTool(
    'usage_by_key',
    {
      description: 'Usage and estimated cost grouped by the value of a conversation metadata key (e.g. accountId) — the billing view. `filters` restricts by other metadata keys.',
      inputSchema: { key: z.string(), days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(), filters: z.record(z.string(), z.string()).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ key, days, filters }) => reply(await api('GET', `/usage/by/${encodeURIComponent(key)}`, { query: { ...filters, days } })),
  )

  server.registerTool(
    'list_providers',
    {
      description:
        'The configured providers that are turned on: protocol, status, whether a key is set (never the key), catalog counts and the agents using each. `includeDisabled: true` lists the ones turned off too.',
      inputSchema: { includeDisabled: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    // ⚖️ Só o que está ATIVO por padrão: o agente que lê isto monta agentes, e um provider desligado não serve.
    async ({ includeDisabled }) => reply(await api('GET', '/providers'), (result) => (includeDisabled ? result : enabledOnly(result))),
  )

  server.registerTool(
    'list_models',
    {
      description:
        "A provider's usable models (enabled and still offered by the provider): price, reasoning support. `includeDisabled: true` lists the whole catalog, to enable one.",
      inputSchema: { providerId: z.string(), includeDisabled: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ providerId, includeDisabled }) =>
      reply(await api('GET', `/providers/${encodeURIComponent(providerId)}/models`), (result) =>
        includeDisabled ? result : enabledOnly(result, (model) => model.available !== false),
      ),
  )

  server.registerTool(
    'list_tools',
    {
      description:
        'Everything an agent can be given in allowedTools: local tools (by name), SDK native tools (`sdk:…`, per provider protocol, with risk) and the MCP servers with their tools (`mcp:<server>/<tool>` or `mcp:<server>/*`).',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const catalog = await api('GET', '/tools')
      if (!catalog.ok) return reply(catalog)
      const { tools, native } = catalog.result as {
        tools?: Array<{ name: string; description: string }>
        native?: Array<{ id: string; protocol: string; label: string; risk: string; officialOnly: boolean }>
      }
      const servers = await api('GET', '/mcp-servers')
      const mcp = servers.ok
        ? await Promise.all(
            ((servers.result as Array<{ id: string; name: string; enabled: boolean }>) ?? [])
              .filter((entry) => entry.enabled)
              .map(async (entry) => {
                const listed = await api('GET', `/mcp-servers/${encodeURIComponent(entry.id)}/tools`)
                const names = listed.ok
                  ? ((listed.result as Array<{ name: string; description: string }>) ?? []).map((tool) => ({ ref: `mcp:${entry.id}/${tool.name}`, description: tool.description }))
                  : []
                return { server: entry.id, name: entry.name, all: `mcp:${entry.id}/*`, tools: names }
              }),
          )
        : []
      return text({ local: (tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })), native, mcp })
    },
  )

  server.registerTool(
    'get_agent',
    { description: 'One agent in full, system prompt included.', inputSchema: { agentId: z.string() }, annotations: { readOnlyHint: true } },
    async ({ agentId }) => reply(await api('GET', `/agents/${encodeURIComponent(agentId)}`)),
  )

  if (!access.write) return

  server.registerTool(
    'set_model_enabled',
    {
      description: 'Enable or disable a model in a provider catalog (only enabled models can be offered by agents).',
      inputSchema: { providerId: z.string(), modelId: z.string(), enabled: z.boolean() },
    },
    async ({ providerId, modelId, enabled }) => reply(await api('PUT', `/providers/${encodeURIComponent(providerId)}/models`, { body: { modelId, enabled } })),
  )

  server.registerTool(
    'set_model_price',
    {
      description:
        'Set the price of a model in a provider catalog, in USD per 1M tokens (saved as a manual price, which syncs never overwrite). Use official pricing pages as the source; never guess.',
      inputSchema: {
        providerId: z.string(),
        modelId: z.string(),
        input: z.number().min(0).max(10000).describe('USD per 1M fresh input tokens'),
        output: z.number().min(0).max(10000).describe('USD per 1M output tokens'),
        cacheRead: z.number().min(0).max(10000).optional(),
        cacheWrite: z.number().min(0).max(10000).optional(),
      },
    },
    async ({ providerId, modelId, ...price }) => reply(await api('PUT', `/providers/${encodeURIComponent(providerId)}/models`, { body: { modelId, price } })),
  )

  server.registerTool(
    'save_agent',
    {
      description: 'Create an agent, or replace the one with the same id. Every problem comes back at once, field by field.',
      inputSchema: agentShape,
    },
    async (agent) => {
      // ⛔ Pelo MCP, nunca ferramenta que alcança este servidor: um prompt injection (de uma busca, de outro
      // MCP) num agente com estas ferramentas de escrita criaria um com `run_bash` e conversaria com ele.
      const dangerous = dangerousToolsOf(agent.allowedTools ?? [])
      if (dangerous.length) {
        return reply({
          ok: false,
          status: 422,
          code: 'validation_error',
          message: `Tools that reach this server cannot be granted through MCP: ${dangerous.join(', ')}. Use the Agents screen.`,
        })
      }
      const exists = (await api('GET', `/agents/${encodeURIComponent(agent.id)}`)).ok
      return reply(exists ? await api('PUT', `/agents/${encodeURIComponent(agent.id)}`, { body: agent }) : await api('POST', '/agents', { body: agent }))
    },
  )
}

/**
 * `POST /v1/mcp` — o gateway como servidor MCP (Streamable HTTP), para Claude Code, Claude Desktop ou outro agente.
 *
 * ⚖️ SEM ESTADO: cada requisição monta o servidor e o transporte e os descarta. As ferramentas dependem de
 * quem chama (admin ou não), e o estado das conversas já mora no gateway; sessão MCP só duplicaria.
 */
export async function handleSelfMcp(req: Request, res: Response): Promise<void> {
  try {
    await serve(req, res)
  } catch (error: unknown) {
    console.error('[self-mcp] Error:', error instanceof Error ? error.message : String(error))
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
  }
}

async function serve(req: Request, res: Response): Promise<void> {
  const api = selfApi(req)
  // A mesma regra da tela: só quem administra lê `/settings`.
  const admin = (await api('GET', '/settings')).ok
  const server = new McpServer({ name: 'agents-gateway', version: '1.0.0' })
  // ⚖️ Escrita LIGADA para admin por padrão (o Atlas precisa dela); `SELF_MCP_WRITE=0` desliga. A API, por
  // baixo, continua só deixando admin escrever.
  registerTools(server, api, { admin, write: process.env.SELF_MCP_WRITE !== '0' })

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}

/** No modo sem estado não há stream nem sessão para abrir ou encerrar. */
export function rejectSelfMcp(_req: Request, res: Response): void {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP server is stateless; use POST.' }, id: null })
}
