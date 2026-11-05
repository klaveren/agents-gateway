import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Request, Response } from 'express'
import { z } from 'zod'
import { IDENTITY_HEADERS } from '@domain/Agent.Identity'
import { CATALOG_KINDS, TCatalogKind } from '@domain/Catalog.Document'
import { PERMISSION_CATEGORIES, TPermissionCategory } from '@domain/Permission.Policy'
import { ISelfReply, selfApi, selfBase, TSelfApi } from './Self.Api'

/** O que a própria API devolveu: o envelope `{ ok, result, message, code, details }` mais o status. */
/**
 * ⛔ Só o header da credencial (`X-Tool-Authorization`, a conta) de quem chamou o MCP segue adiante. Nada do
 * corpo do MCP vira identidade. ⚖️ Os cabeçalhos de identidade do agente (agente, conversa) vão junto como RÓTULO: a
 * API os usa para dizer quem fez o pedido de permissão. A única leitura que eles abrem (as próprias regras) a API
 * confere contra a sessão viva da conta que chama.
 */
function callerApi(req: Request): TSelfApi {
  const credentials: Record<string, string> = {}
  for (const name of ['x-tool-authorization', IDENTITY_HEADERS.agent, IDENTITY_HEADERS.conversation]) {
    const value = req.headers[name]
    if (typeof value === 'string') credentials[name] = value
  }
  return selfApi(selfBase(req), credentials)
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

/** Acima disto, um texto da resposta de gravação vira só o tamanho. */
const ECHO_TEXT_MAX = 300

/**
 * ⚖️ A RESPOSTA DE UMA GRAVAÇÃO: o item salvo sem os textos longos (corpo, prompt, soul, corpo de trigger), que viram
 * `"[N caracteres]"`. Quem gravou já tem o texto; ecoá-lo inteiro estourava a resposta (o agente inteiro, ~160 mil
 * caracteres, a cada `resolve_import_issue`). O resto (ids, listas, problemas) volta como está. Ler: as de leitura.
 */
export function savedEcho(value: unknown): unknown {
  if (typeof value === 'string') return value.length > ECHO_TEXT_MAX ? `[${value.length} caracteres]` : value
  if (Array.isArray(value)) return value.map(savedEcho)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, savedEcho(item)]))
  return value
}

/** A fonte no repositório de um item gravado por fora do importador (ver `withImported`). */
const importedFrom = z
  .object({
    path: z.string().describe('The source path in the repository, as the importer lists it (a file, or its folder)'),
    repository: z.string().optional().describe('The repository id, when the same path exists in more than one'),
    projectId: z.string().optional().describe('The project of the import; absent = the project of the saved item'),
  })
  .optional()
  .describe('You migrated this item from the repository yourself: the importer marks the source as imported (by you), and it leaves the queue.')

/**
 * Gravou e veio de uma fonte do repositório (`importedFrom`): avisa o importador, que marca o item como importado pelo
 * agente. A gravação vale sozinha: se o aviso falhar, a resposta diz por quê, e o item do catálogo fica como gravado.
 */
async function withImported(
  api: TSelfApi,
  saved: ISelfReply,
  source: z.infer<typeof importedFrom>,
  target: (result: Record<string, unknown>) => { kind: string; id: string; projectId?: string },
): Promise<ReturnType<typeof reply>> {
  if (!saved.ok || !source) return reply(saved, savedEcho)
  const item = target((saved.result ?? {}) as Record<string, unknown>)
  const projectId = source.projectId ?? item.projectId
  const marked = projectId
    ? await api('POST', `/projects/${encodeURIComponent(projectId)}/import/imported`, {
        body: { path: source.path, ...(source.repository ? { repository: source.repository } : {}), kind: item.kind, id: item.id },
      })
    : { ok: false, status: 422, message: 'importedFrom.projectId: the saved item is global; send the project of the import' }
  const importer = marked.ok
    ? { marked: true, key: (marked.result as { key?: string } | undefined)?.key, repository: (marked.result as { repository?: string } | undefined)?.repository }
    : { marked: false, message: detailOf(marked) }
  return text({ ...(savedEcho(saved.result) as Record<string, unknown>), importer })
}

/** O motivo de uma recusa da API: o problema do campo, quando há (a mensagem sozinha é só "Request body is invalid"). */
function detailOf(answer: ISelfReply): string | undefined {
  const issues = Array.isArray(answer.details) ? (answer.details as Array<{ field?: string; message?: string }>) : []
  return issues.length ? issues.map((issue) => (issue.field ? `${issue.field}: ${issue.message}` : String(issue.message))).join('; ') : answer.message
}

/** O índice dos recursos: o que diz QUAL é e QUANDO usar, sem o corpo (lido um a um, com o id). */
function resourceIndex(result: unknown): unknown {
  if (!Array.isArray(result)) return result
  return (result as Array<Record<string, unknown>>).map((resource) => ({
    id: resource.id,
    kind: resource.kind,
    ...(resource.projectId ? { projectId: resource.projectId } : {}),
    description: resource.description,
    ...(Array.isArray(resource.docIds) && resource.docIds.length ? { docIds: resource.docIds } : {}),
    ...(Array.isArray(resource.files) && resource.files.length ? { files: resource.files.length } : {}),
    ...(Array.isArray(resource.importIssues) && resource.importIssues.length ? { importIssues: resource.importIssues.length } : {}),
    ...(Array.isArray(resource.triggers) && resource.triggers.length ? { triggers: resource.triggers.length } : {}),
    ...(Array.isArray(resource.tags) && resource.tags.length ? { tags: resource.tags } : {}),
    bodyChars: typeof resource.body === 'string' ? resource.body.length : 0,
  }))
}

/**
 * ⚖️ QUANTO O MCP ESPERA UM TURNO antes de devolver `running`, conforme o que o cliente aguenta:
 * - resposta JSON (sem fluxo): 50 s, abaixo dos 60 s em que o SDK desiste da chamada;
 * - em fluxo (SSE), com `progressToken`: ⛔ ATÉ O TURNO ACABAR, SEM TETO — quem conversa com um agente espera a
 *   resposta, por mais que ela demore. O aviso de progresso a cada 15 s mantém viva a chamada (o Claude Code aborta
 *   depois de 5 min sem resposta nem progresso); o cliente que desliga encerra a espera (`signal`);
 * - em fluxo sem `progressToken`: 4 min, abaixo desses 5 min.
 * Turno mais longo segue no servidor; quem chamou acompanha com `get_turn`.
 */
const TURN_WAIT = {
  json: { default: 45, max: 50 },
  stream: { default: 240, max: 240 },
  progress: { default: Infinity, max: Infinity },
} as const
const TURN_POLL_MS = 1000
const TURN_PROGRESS_MS = 15_000
/** As ferramentas que seguram a chamada até o fim do turno: só elas respondem em fluxo (ver `serve`). */
const TURN_TOOLS = new Set(['start_conversation', 'send_message', 'get_turn'])

/** O que a chamada da ferramenta traz do cliente para a espera: o progresso, o cancelamento e o modo da resposta. */
export interface ITurnWait {
  streaming: boolean
  progressToken?: string | number
  signal?: AbortSignal
  notify?: (progress: number, message: string) => Promise<void>
  /** Os intervalos de consulta e de progresso (o teste encurta). */
  pollMs?: number
  progressMs?: number
}

/** A espera de uma chamada, a partir do que o SDK entrega ao handler. */
function turnWait(streaming: boolean, extra: { _meta?: { progressToken?: string | number }; signal?: AbortSignal; sendNotification?: (n: never) => Promise<void> }): ITurnWait {
  const progressToken = streaming ? extra._meta?.progressToken : undefined
  const send = extra.sendNotification
  return {
    streaming,
    ...(progressToken !== undefined ? { progressToken } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(progressToken !== undefined && send
      ? { notify: (progress: number, message: string) => send({ method: 'notifications/progress', params: { progressToken, progress, message } } as never) }
      : {}),
  }
}

/** O teto da espera para esta chamada, segundo o modo (ver `TURN_WAIT`). */
function waitLimits(wait: ITurnWait): { default: number; max: number } {
  return !wait.streaming ? TURN_WAIT.json : wait.progressToken !== undefined ? TURN_WAIT.progress : TURN_WAIT.stream
}

const waitSecondsShape = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    `How long to wait for the turn to finish. Default: until it ends, with no limit, when the client streams (SSE) and sends a progressToken (a progress notification every ${TURN_PROGRESS_MS / 1000} s keeps the call alive); ${TURN_WAIT.stream.max} s when it streams without one; ${TURN_WAIT.json.max} s on a plain JSON response. Still running after that: \`status: running\`; call get_turn.`,
  )

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * O turno `turn` até acabar ou até `waitSeconds` passar — o que vier primeiro. Em fluxo, avisa o progresso a cada 15 s
 * (as ferramentas usadas até ali). ⛔ O cliente que desliga (`signal`) encerra a espera: o turno segue no servidor.
 */
export async function awaitTurn(api: TSelfApi, sessionId: string, turn: number, waitSeconds: number | undefined, wait: ITurnWait): Promise<ISelfReply> {
  const limits = waitLimits(wait)
  const pollMs = wait.pollMs ?? TURN_POLL_MS
  const progressMs = wait.progressMs ?? TURN_PROGRESS_MS
  const startedAt = Date.now()
  const deadline = startedAt + Math.min(Math.max(waitSeconds ?? limits.default, 0), limits.max) * 1000
  let nextProgress = startedAt + progressMs
  for (;;) {
    const answer = await api('GET', `/sessions/${encodeURIComponent(sessionId)}/turns/${turn}`)
    const running = answer.ok && (answer.result as { status?: string }).status === 'running'
    if (!running || wait.signal?.aborted || Date.now() + pollMs > deadline) return answer
    if (wait.notify && Date.now() >= nextProgress) {
      nextProgress = Date.now() + progressMs
      const tools = ((answer.result as { tools?: unknown }).tools as string[] | undefined) ?? []
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      await wait.notify(seconds, `running for ${seconds} s${tools.length ? ` · ${tools.length} tool calls, last: ${tools.at(-1)}` : ''}`).catch(() => undefined)
    }
    await sleep(pollMs)
  }
}

/** Começa o turno (`POST …/turns`, assíncrono) e espera o quanto der. */
async function startTurn(api: TSelfApi, sessionId: string, message: string, waitSeconds: number | undefined, wait: ITurnWait): Promise<ISelfReply> {
  const started = await api('POST', `/sessions/${encodeURIComponent(sessionId)}/turns`, { body: { message } })
  if (!started.ok) return started
  return awaitTurn(api, sessionId, (started.result as { turn: number }).turn, waitSeconds, wait)
}

/** O estado do turno para quem chamou: o texto até aqui, as ferramentas, o fim. */
function turnStatusView(result: unknown) {
  const turn = (result ?? {}) as Record<string, unknown>
  return {
    sessionId: turn.conversationId,
    turn: turn.turn,
    status: turn.status,
    text: turn.text,
    tools: turn.tools,
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
  }
}

/**
 * ⛔ AS FERRAMENTAS DE CONVERSA, só para quem está de fora (pessoa, integração) — ver `PEOPLE_ONLY_GATEWAY_TOOLS`.
 * ⚖️ A ESPERA SEGUE O CLIENTE (ver `TURN_WAIT`): em fluxo com progresso, a chamada fica aberta até o turno acabar, e
 * quem conversa não precisa perguntar de novo; em JSON, 50 s e `running`, como antes.
 */
function registerConversationTools(server: McpServer, api: TSelfApi, streaming: boolean) {
  server.registerTool(
    'start_conversation',
    {
      description:
        'Open a conversation with an agent. With `message`, also starts the first turn and waits for it (see `waitSeconds`: on a streaming client, until it ends); a longer turn comes back as `status: running` — follow it with get_turn. `metadata` is stored with the conversation (e.g. { accountId, userId }) for billing and filtering.',
      inputSchema: {
        agentId: z.string(),
        mode: z.enum(['chat', 'agent']).optional().describe('chat = plain SDK; agent = the provider Agents SDK.'),
        provider: z.string().optional().describe('One of the agent providers; default: the first that offers `model`.'),
        model: z.string().optional(),
        reasoning: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        projectId: z.string().optional().describe('For a global agent: the project the conversation belongs to. A project agent always opens in its own project.'),
        message: z.string().optional(),
        waitSeconds: waitSecondsShape,
      },
    },
    async ({ message, waitSeconds, ...body }, extra) => {
      const created = await api('POST', '/sessions', { body })
      if (!created.ok || !message) return reply(created)
      return reply(await startTurn(api, (created.result as { id: string }).id, message, waitSeconds, turnWait(streaming, extra)), turnStatusView)
    },
  )

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message in a live conversation: starts the turn and waits for it (see `waitSeconds`: on a streaming client, until it ends, with progress while it runs). Still running after that: `status: running` — follow it with get_turn.',
      inputSchema: { sessionId: z.string(), message: z.string(), waitSeconds: waitSecondsShape },
    },
    async ({ sessionId, message, waitSeconds }, extra) => reply(await startTurn(api, sessionId, message, waitSeconds, turnWait(streaming, extra)), turnStatusView),
  )

  server.registerTool(
    'get_turn',
    {
      description:
        'Follow a turn started by start_conversation or send_message: waits for it to finish (see `waitSeconds`), then returns its status (`running`, `ok`, `error`, `aborted`) and text.',
      inputSchema: { sessionId: z.string(), turn: z.number().int().min(0), waitSeconds: waitSecondsShape },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, turn, waitSeconds }, extra) => reply(await awaitTurn(api, sessionId, turn, waitSeconds, turnWait(streaming, extra)), turnStatusView),
  )
}

const agentShape = {
  id: z.string().describe('2–48 lowercase letters, digits or hyphens.'),
  name: z.string(),
  tags: z.array(z.string()).optional().describe('Free words to group and filter in the lists (normalized to lowercase-hyphen); absent on update = keep, [] removes all'),
  soul: z.string().optional().describe('Who the agent is: identity, tone, values, way of speaking. The system prompt says what it does.'),
  providers: z
    .array(
      z.object({
        provider: z.string().describe('A configured provider id (claude, openai, google, a subscription or a compatible one).'),
        models: z.array(z.string()).describe('Models ENABLED in that provider catalog; the first is the default.'),
        sandbox: z
          .enum(['read-only', 'workspace-write', 'full'])
          .optional()
          .describe('Codex/Antigravity sandbox; the protocol sandboxLevels say which apply. Absent = read-only. `full` = no sandbox, runs as the gateway process.'),
        network: z.boolean().optional().describe('Codex: open the network inside the sandbox. Absent = no network.'),
      }),
    )
    .describe('Where the agent runs: one or more providers, each with its models. The first is the default; a conversation can switch between them.'),
  systemPrompt: z.string(),
  reasoningEfforts: z.array(z.string()).optional(),
  modes: z.array(z.enum(['chat', 'agent'])),
  allowedTools: z.array(z.string()).default([]).describe('Local names, `sdk:…` natives and `mcp:<server>/<tool>`; see list_tools.'),
  role: z
    .enum(['subagent'])
    .nullable()
    .optional()
    .describe('`subagent`: only called by another agent through delegation (`agent:<id>`), never in a direct conversation. `null` makes it a regular agent.'),
  adminOnly: z.boolean().optional().describe('Only administrators can talk to the agent. Absent or false = open to every account.'),
  projectId: z
    .string()
    .nullable()
    .optional()
    .describe('The project the agent belongs to (see list_projects): it only works in that project folder and only its members see it. Absent or null = global (every project).'),
}

/** O alvo das regras de permissão: um agente ou um projeto (a camada de baixo). */
const permissionTarget = { scope: z.enum(['agent', 'project']), id: z.string().describe('The agent id or the project id.') }
const targetPath = (scope: 'agent' | 'project', id: string) => `/${scope === 'agent' ? 'agents' : 'projects'}/${encodeURIComponent(id)}`

/** ⛔ O aviso vem PRIMEIRO e em texto: é o que o agente repassa à pessoa (pendente ≠ liberado). */
function pendingReply(answer: ISelfReply) {
  if (!answer.ok) return reply(answer)
  const { notice, ...result } = answer.result as { notice: string }
  return {
    content: [
      { type: 'text' as const, text: notice },
      { type: 'text' as const, text: JSON.stringify(result) },
    ],
  }
}

const permissionRuleShape = z.object({
  category: z.enum(PERMISSION_CATEGORIES as [TPermissionCategory, ...TPermissionCategory[]]),
  pattern: z
    .string()
    .describe('terminal: words, `*` = any arguments (`git push *`); read/write: a path glob (`src/**`); network: a host (`*.github.com`); the others: a name with `*`.'),
  decision: z.enum(['allow', 'deny']),
  note: z.string().optional(),
})

/**
 * As ferramentas, segundo quem chama.
 *
 * ⛔ Ferramenta de admin NEM É REGISTRADA para quem não administra, e as de escrita só existem com
 * `SELF_MCP_WRITE=0` desligando — o cliente não vê o que não pode usar. A API, por baixo, recusaria de qualquer jeito.
 * ⛔ Chave de API e senha não passam por aqui: não há ferramenta para elas.
 */
function registerTools(server: McpServer, api: TSelfApi, access: { admin: boolean; write: boolean; agentId?: string; streaming?: boolean }) {
  server.registerTool(
    'list_projects',
    {
      description:
        'The projects you can use (an administrator sees all, with the folder and member count). Agents and conversations belong to a project; models, MCP servers and packages are global.',
      annotations: { readOnlyHint: true },
    },
    async () => reply(await api('GET', '/projects')),
  )

  server.registerTool(
    'list_agents',
    {
      description:
        'List the agents: providers, each with its models (with price) and reasoning levels per model, lanes and tools, and `projectId` (absent = global). With `projectId`, only that project agents plus the global ones. Never includes the system prompt. Agents with `role: subagent` are only called by other agents and cannot start a conversation.',
      inputSchema: { projectId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) => reply(await api('GET', '/agents', { query: { project: projectId } })),
  )

  // ⛔ Agente não conversa por aqui: fala com outro só por `delegate_to_agent`, com as travas da delegação.
  if (!access.agentId) registerConversationTools(server, api, access.streaming === true)

  server.registerTool(
    'switch_model',
    {
      description:
        'Switch the provider, model and/or reasoning level of a live conversation, from the next message on. Another provider of the agent receives a transcript of the previous turns (its internal state does not carry over); `reasoning: null` = provider default.',
      inputSchema: { sessionId: z.string(), provider: z.string().optional(), model: z.string().optional(), reasoning: z.string().nullable().optional() },
    },
    async ({ sessionId, ...change }) => reply(await api('PATCH', `/sessions/${encodeURIComponent(sessionId)}`, { body: change })),
  )

  server.registerTool(
    'list_conversations',
    {
      description: 'List conversations (yours; an administrator sees all). `projectId` keeps one project; `metadata` filters by stored metadata keys, e.g. { accountId: "xpto" }.',
      inputSchema: {
        q: z.string().optional(),
        projectId: z.string().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ q, projectId, metadata, limit }) =>
      reply(await api('GET', '/conversations', { query: { ...metadata, q, limit, project: projectId } }), (result) =>
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

  server.registerTool(
    'list_permission_rules',
    {
      description:
        "The permission rules { category, pattern, decision: allow|deny } of a target — `{ scope: 'agent' | 'project', id }` — and its requests waiting for an administrator. Agent rules decide before the project's; deny wins within a layer; no rule = denied. Any agent may read its OWN rules (`scope: 'agent'` without `id`); other agents and projects are for administrators.",
      inputSchema: { scope: permissionTarget.scope, id: permissionTarget.id.optional().describe("The agent id or the project id. Absent with scope 'agent' = you.") },
      annotations: { readOnlyHint: true },
    },
    async ({ scope, id }) => {
      // ⛔ "Eu" é o agente do cabeçalho de identidade, que o gateway põe; a API confere contra a sessão viva.
      const target = id ?? (scope === 'agent' ? access.agentId : undefined)
      if (!target)
        return { ...text({ code: 'validation_error', message: scope === 'agent' ? 'no agent identity in this call: pass `id`' : '`id` is required for a project' }), isError: true }
      return reply(await api('GET', `${targetPath(scope, target)}/permission-rules`))
    },
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
    'list_errors',
    {
      description:
        'The ERROR LOG of the conversations: tool calls that failed (with the tool and the message), turns that ended in error, and interrupted turns — newest first, with counts by kind and the tools that fail most. Filter by `days` (default 7, max 90), `agentId`, `tool`, `kind` (tool | turn | aborted). Use it to find what keeps failing and open a ticket for it.',
      inputSchema: {
        days: z.number().int().min(1).max(90).optional(),
        agentId: z.string().optional(),
        tool: z.string().optional(),
        kind: z.enum(['tool', 'turn', 'aborted']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (query) => reply(await api('GET', '/errors', { query })),
  )

  server.registerTool(
    'list_secret_names',
    {
      description:
        'The SECRET VARIABLES of an agent, skill or command: only names, descriptions and when they changed — never the value. They are in the environment of your commands as `$NAME` (an agent one always; a skill or command one after you load it). Use them in commands, never print them.',
      inputSchema: { scope: z.enum(['agent', 'resource']).describe('agent, or resource (a skill or command)'), id: z.string().describe('The agent id or the skill/command id.') },
      annotations: { readOnlyHint: true },
    },
    async ({ scope, id }) => reply(await api('GET', `/${scope === 'agent' ? 'agents' : 'resources'}/${encodeURIComponent(id)}/secrets`)),
  )

  server.registerTool(
    'list_model_groups',
    {
      description:
        'The model groups (Settings → model groups): ordered steps (provider + model) and when to switch. An agent points to one (`modelGroup`; absent = `defaultModelGroup`, `none` = no switching): a conversation opened without a model starts at the first available step, and when a model fails (quota, rate limit, model unavailable…) the conversation moves to the next step and STAYS there. Groups are edited only on the screen.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      reply(await api('GET', '/settings'), (result) => {
        const settings = result as { modelGroups?: unknown[]; defaultModelGroup?: string }
        return { defaultModelGroup: settings.defaultModelGroup ?? null, modelGroups: settings.modelGroups ?? [] }
      }),
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
        'Everything an agent can be given in allowedTools: capabilities (`cap:terminal`, `cap:files.read`, `cap:files.write`, `cap:web.search`, `cap:web.fetch`, `cap:todos` — the gateway decides per provider what runs; `runs` says how), other local tools (by name), provider-only SDK extras (`sdk:…`, with risk) and the MCP servers with their tools (`mcp:<server>/<tool>` or `mcp:<server>/*`; a server with `projectId` serves only agents of that project). Prefer capabilities over the old ids (run_bash, sdk:Read…), which are converted on save.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const catalog = await api('GET', '/tools')
      if (!catalog.ok) return reply(catalog)
      const { tools, native, capabilities } = catalog.result as {
        tools?: Array<{ name: string; description: string }>
        capabilities?: Array<{ id: string; label: string; description: string; risk: string; runs: Record<string, string> }>
        native?: Array<{ id: string; protocol: string; label: string; risk: string; officialOnly: boolean }>
      }
      const servers = await api('GET', '/mcp-servers')
      const mcp = servers.ok
        ? await Promise.all(
            ((servers.result as Array<{ key?: string; id: string; projectId?: string; name: string; enabled: boolean }>) ?? [])
              .filter((entry) => entry.enabled)
              .map(async (entry) => {
                const listed = await api('GET', `/mcp-servers/${encodeURIComponent(entry.key ?? entry.id)}/tools`)
                const names = listed.ok
                  ? ((listed.result as Array<{ name: string; description: string }>) ?? []).map((tool) => ({ ref: `mcp:${entry.id}/${tool.name}`, description: tool.description }))
                  : []
                // `projectId`: o servidor só serve a agente daquele projeto (ausente = global).
                return { server: entry.id, ...(entry.projectId ? { projectId: entry.projectId } : {}), name: entry.name, all: `mcp:${entry.id}/*`, tools: names }
              }),
          )
        : []
      return text({ capabilities, local: (tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })), native, mcp })
    },
  )

  server.registerTool(
    'get_agent',
    {
      description:
        'One agent in full, system prompt included, and its importIssues (problems recorded when it was imported; fix them, then resolve_import_issue). `fields` returns only those fields (e.g. ["allowedTools","permissions"]).',
      inputSchema: { agentId: z.string(), fields: z.array(z.string()).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId, fields }) =>
      reply(await api('GET', `/agents/${encodeURIComponent(agentId)}`), (result) =>
        fields?.length ? Object.fromEntries(Object.entries(result as Record<string, unknown>).filter(([key]) => key === 'id' || fields.includes(key))) : result,
      ),
  )

  server.registerTool(
    'preview_system_prompt',
    {
      description:
        'The final system prompt an agent receives in a new conversation (soul, instructions, environment, rules, initial context, indexes, its ledger index). Without `part`: the SUMMARY, characters and ≈tokens in total and per part, without the text. With `part` (a key from the summary): that part in full; `all` = the whole prompt (it can be very large). `projectId`: the conversation project, for a global agent.',
      inputSchema: {
        agentId: z.string(),
        projectId: z.string().optional(),
        part: z.string().optional().describe('A part key from the summary (soul, instructions, rules, skills, triggers…), or all'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId, projectId, part }) => {
      const path = `/agents/${encodeURIComponent(agentId)}/system-prompt`
      if (part === 'all') return reply(await api('GET', path, { query: { project: projectId } }))
      if (part) return reply(await api('GET', path, { query: { project: projectId, part } }))
      // ⚖️ O resumo: o prompt inteiro de um agente grande estourava a resposta.
      return reply(await api('GET', path, { query: { project: projectId } }), (result) => {
        const { prompt: _prompt, ...summary } = (result ?? {}) as Record<string, unknown>
        return summary
      })
    },
  )

  server.registerTool(
    'list_packages',
    {
      description:
        'The server tools installed from the Packages tab — conda-forge (micromamba) in `packages`, and the npm registry in `npm.packages` — into a persistent folder on the PATH of every agent Bash, run_bash and local MCP. `explicit` = asked for; the rest came as dependencies.',
      annotations: { readOnlyHint: true },
    },
    async () => reply(await api('GET', '/packages')),
  )

  server.registerTool(
    'search_packages',
    {
      description:
        'Search for a server tool by name: conda-forge by default (git, curl, jq, ffmpeg, ripgrep…), or the npm registry with `source: "npm"` (Node CLIs such as mongosh). One hit per package, newest version, exact name first. The first conda search on a fresh server takes ~15s.',
      inputSchema: { query: z.string().min(2).max(100), source: z.enum(['conda', 'npm']).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query, source }) => reply(await api('GET', '/packages/search', { query: { q: query, ...(source ? { source } : {}) } })),
  )

  server.registerTool(
    'list_hooks',
    {
      description:
        "An agent's hooks: POST /v1/hook/<agentId>/<name> runs the hook prompt with the received event, as the account that created it. Shows the path, verification, conversation mode, the key's last 4 characters and the last delivery — never the key.",
      inputSchema: { agentId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId }) => reply(await api('GET', `/agents/${encodeURIComponent(agentId)}/hooks`)),
  )

  server.registerTool(
    'hook_deliveries',
    {
      description: 'The last 20 calls of a hook: when, status (running, ok, error), the error and the conversation it opened.',
      inputSchema: { agentId: z.string(), name: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId, name }) => reply(await api('GET', `/agents/${encodeURIComponent(agentId)}/hooks/${encodeURIComponent(name)}/deliveries`)),
  )

  server.registerTool(
    'list_schedules',
    {
      description:
        "An agent's schedules (or every schedule, without agentId): at the times of a cron expression the agent runs a text, as the account that created it — the result is a conversation in that account's inbox. Shows cron, timezone, the text, the next run, failures and the last run.",
      inputSchema: { agentId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId }) => reply(await api('GET', agentId ? `/agents/${encodeURIComponent(agentId)}/schedules` : '/schedules')),
  )

  server.registerTool(
    'list_rules',
    {
      description:
        'The environment rules (Rule 1, Rule 2…) of one scope, in order: every agent gets the enabled ones in its system prompt when a conversation starts — the global ones first, then those of the conversation project. Absent projectId = the global rules.',
      inputSchema: { projectId: z.string().optional().describe('A project id (see list_projects); absent = global') },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) => reply(await api('GET', '/rules', { query: { project: projectId ?? 'global' } })),
  )

  server.registerTool(
    'list_docs',
    {
      description:
        'The reference documents (specs, ADRs and knowledge studies) of one scope, without the body. Conversations get an index (id, title, summary) of the global ones plus those of their project, and agents read one in full with read_doc. Absent projectId = the global ones.',
      inputSchema: { projectId: z.string().optional(), kind: z.enum(['spec', 'adr', 'knowledge']).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, kind }) => reply(await api('GET', '/docs', { query: { project: projectId ?? 'global', kind } })),
  )

  server.registerTool(
    'get_doc',
    {
      description:
        'One spec or ADR in full, markdown body included, with its attachments (docIds, and docRefs: those by reference) and its importIssues (problems recorded when it was imported; fix them, then resolve_import_issue).',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => reply(await api('GET', `/docs/${encodeURIComponent(id)}`)),
  )

  server.registerTool(
    'import_items',
    {
      description:
        'The IMPORTER queue of a project, without content: per repository, how many items are in each state and, per item, its key, kind, state, source path and who imported it outside the importer (importedBy). Filter by state (pending, applied, skipped…), kind or repository. Use it to plan a migration and to CHECK, after saving with importedFrom, that the item left the queue.',
      inputSchema: {
        projectId: z.string(),
        repository: z.string().optional(),
        state: z.string().optional().describe('pending, drafting, review, approved, rejected, skipped, applied, error or stale'),
        kind: z.string().optional().describe('skill, command, rule, spec, adr, knowledge, agent, trigger…'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, repository, state, kind }) => {
      const base = `/projects/${encodeURIComponent(projectId)}/import/jobs`
      const jobs = await api('GET', base)
      if (!jobs.ok) return reply(jobs)
      const summaries = ((jobs.result ?? []) as Array<{ id: string; repository: string; byState?: Record<string, number> }>).filter(
        (job) => !repository || job.repository === repository,
      )
      const out: Array<Record<string, unknown>> = []
      for (const summary of summaries) {
        const full = await api('GET', `${base}/${encodeURIComponent(summary.id)}`)
        if (!full.ok) return reply(full)
        const job = full.result as {
          scan?: { items?: Array<{ key: string; kind: string; sources?: Array<{ path: string }> }> }
          states?: Array<{ key: string; state: string; kind?: string; goneAt?: string; importedBy?: { kind: string; id: string; agentId?: string } }>
        }
        const states = new Map((job.states ?? []).map((entry) => [entry.key, entry]))
        const items = (job.scan?.items ?? [])
          .map((item) => {
            const status = states.get(item.key)
            const effective = status?.kind ?? item.kind
            return {
              key: item.key,
              kind: effective,
              state: status?.state ?? 'pending',
              path: item.sources?.[0]?.path,
              ...(status?.goneAt ? { gone: true } : {}),
              ...(status?.importedBy ? { importedBy: `${status.importedBy.agentId ?? 'api'} → ${status.importedBy.kind} ${status.importedBy.id}` } : {}),
            }
          })
          .filter((item) => (!state || item.state === state) && (!kind || item.kind === kind))
        out.push({
          repository: summary.repository,
          jobId: summary.id,
          byState: summary.byState,
          items: items.length,
          list: items.slice(0, 400),
          ...(items.length > 400 ? { truncated: 'narrow it with state or kind' } : {}),
        })
      }
      return text(out)
    },
  )

  server.registerTool(
    'catalog_history',
    {
      description:
        "The revision history of one catalog item (spec, ADR, knowledge, rule, agent, skill, command, protocol, project, mcp): every save keeps a revision with its author. action list = the revisions, newest first (and the current one); show = one revision in full; diff = the line diff between two revisions (to defaults to the current state); restore = a NEW revision with the content of an old one (nothing is erased). Restore needs expectedRevision (the latest you saw: refused if someone changed it since) and the person's OK first; a restore that widens an agent's permissions is refused here and only the person can accept it on the screen.",
      inputSchema: {
        action: z.enum(['list', 'show', 'diff', 'restore']),
        kind: z.enum(CATALOG_KINDS as unknown as [TCatalogKind, ...TCatalogKind[]]),
        id: z.string(),
        projectId: z.string().optional().describe('For an mcp server of a project'),
        revision: z.number().int().min(1).optional().describe('show and restore: the revision number'),
        from: z.number().int().min(0).optional().describe('diff: the older revision'),
        to: z.number().int().min(0).optional().describe('diff: the newer revision; absent = the current state'),
        expectedRevision: z.number().int().min(0).optional().describe('restore: the latest revision you saw (from list)'),
        page: z.number().int().min(1).optional().describe('list: the page (newest first)'),
      },
    },
    async ({ action, kind, id, projectId, revision, from, to, expectedRevision, page }) => {
      const item = { kind, id, ...(projectId ? { project: projectId } : {}) }
      const refuse = (message: string) => ({ ...text({ status: 422, code: 'validation_error', message }), isError: true })
      if (action === 'list') return reply(await api('GET', '/catalog/history', { query: { ...item, ...(page ? { page: String(page) } : {}) } }))
      if (action === 'diff')
        return reply(
          await api('GET', '/catalog/history/diff', { query: { ...item, ...(from !== undefined ? { from: String(from) } : {}), to: to !== undefined ? String(to) : 'current' } }),
        )
      if (revision === undefined) return refuse(`revision is required for ${action}`)
      if (action === 'show') return reply(await api('GET', `/catalog/history/revisions/${revision}`, { query: item }))
      if (!access.write) return refuse('restore is disabled on this server (SELF_MCP_WRITE=0)')
      if (expectedRevision === undefined) return refuse('expectedRevision is required for restore: the latest revision from list')
      return reply(await api('POST', '/catalog/history/restore', { body: { ...item, revision, expectedRevision } }), savedEcho)
    },
  )

  server.registerTool(
    'get_initial_context',
    {
      description:
        'The initial context of a project: the specs that go IN FULL into the system prompt of every conversation of that project, next to the rules, in order (with estimated tokens). Specs not listed stay in the index and agents read them with read_doc.',
      inputSchema: { projectId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) => reply(await api('GET', `/projects/${encodeURIComponent(projectId)}/initial-context`)),
  )

  server.registerTool(
    'get_agent_initial_context',
    {
      description:
        "The initial context of an agent: the specs it loads IN FULL on top of its project's initial context (e.g. the architecture specs for a developer agent), in order, with estimated tokens.",
      inputSchema: { agentId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId }) => reply(await api('GET', `/agents/${encodeURIComponent(agentId)}/initial-context`)),
  )

  server.registerTool(
    'list_resources',
    {
      description:
        'The skills and commands of one scope: without id, the INDEX (id, kind, description, attached docs, file and trigger counts and body size, never the body); with id, that one in full (body, files, triggers, importIssues). A skill is a way of doing something that an agent loads with use_resource when the subject comes up; a command is a ready request the person fires with /name args (its body uses $ARGUMENTS). Both can carry specs/ADRs (docIds). Agents use all of their scope by default (global ones, plus those of their project); the Resources tab of an agent can restrict that. Absent projectId = the global ones.',
      inputSchema: {
        id: z.string().optional().describe('One resource in full; absent = the index of the scope'),
        projectId: z.string().optional(),
        kind: z.enum(['skill', 'command']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, projectId, kind }) => {
      if (id) return reply(await api('GET', `/resources/${encodeURIComponent(id)}`))
      // ⚖️ O índice, nunca os corpos: 55 skills inteiras passavam de 100 mil caracteres e estouravam a resposta.
      return reply(await api('GET', '/resources', { query: { project: projectId ?? 'global', kind } }), resourceIndex)
    },
  )

  server.registerTool(
    'get_protocol',
    {
      description:
        'How a skill, command, rule, spec, ADR or knowledge study must be built in this gateway: the core protocol (shipped with the gateway, versioned) and the administrators addenda (global, then the project one), which add to it. Follow both when creating or adjusting one.',
      inputSchema: { kind: z.enum(['skill', 'command', 'rule', 'spec', 'adr', 'knowledge']), projectId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, projectId }) => reply(await api('GET', `/protocols/${kind}`, { query: { project: projectId } })),
  )

  server.registerTool(
    'get_agent_resources',
    {
      description: 'The skills and commands an agent may use: ids, or ["*"] = every global one plus those of its project (the default, when nothing was set), or [] = none.',
      inputSchema: { agentId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId }) => reply(await api('GET', `/agents/${encodeURIComponent(agentId)}/resources`)),
  )

  if (!access.write) return

  server.registerTool(
    'save_project',
    {
      description:
        'Create a project, or change the name/description of the one with the same id (the id cannot change). A project gets its own folder; its agents work there and only its members see them. Confirm with the person first.',
      inputSchema: { id: z.string().describe('2–32 lowercase letters, digits or hyphens'), name: z.string(), description: z.string().optional() },
    },
    async ({ id, ...fields }) => {
      const exists = ((await api('GET', '/projects')).result as Array<{ id: string }> | undefined)?.some((project) => project.id === id)
      return reply(exists ? await api('PUT', `/projects/${encodeURIComponent(id)}`, { body: fields }) : await api('POST', '/projects', { body: { id, ...fields } }))
    },
  )

  server.registerTool(
    'set_project_members',
    {
      description:
        'Replace the whole member list of a project with these account ids (anyone not listed leaves). Administrators see every project anyway. Confirm with the person first.',
      inputSchema: { projectId: z.string(), userIds: z.array(z.string()) },
    },
    async ({ projectId, userIds }) => reply(await api('PUT', `/projects/${encodeURIComponent(projectId)}/members`, { body: { userIds } })),
  )

  server.registerTool(
    'save_hook',
    {
      description:
        'Create a hook on an agent, or change the one with the same name (the name can\'t change). It runs as YOU, the person in this conversation. The key is NOT returned here on purpose — it would be stored in the conversation. The person gets it in the screen: /agents/<agentId>, tab Hooks, "Trocar chave" generates a NEW key and shows it once (the one generated now is replaced; do not mention its last characters). verify: key (Authorization: Bearer / X-Hook-Key) or hmac (signature of the raw body, GitHub style). session: new (one conversation per call) or continuous (one conversation, calls queued).',
      inputSchema: {
        agentId: z.string(),
        name: z.string().describe('2–48 lowercase letters, digits or hyphens; the end of the URL'),
        prompt: z.string().describe('What the agent does when the event arrives; the event is appended'),
        enabled: z.boolean().optional(),
        verify: z.enum(['key', 'hmac']).optional(),
        signatureHeader: z.string().optional().describe('hmac: default X-Hub-Signature-256'),
        signaturePrefix: z.string().optional().describe('hmac: default sha256='),
        signatureEncoding: z.enum(['hex', 'base64']).optional(),
        session: z.enum(['new', 'continuous']).optional(),
      },
    },
    async ({ agentId, name, ...fields }) => {
      const path = `/agents/${encodeURIComponent(agentId)}/hooks`
      const exists = ((await api('GET', path)).result as Array<{ name: string }> | undefined)?.some((hook) => hook.name === name)
      const saved = exists ? await api('PUT', `${path}/${encodeURIComponent(name)}`, { body: fields }) : await api('POST', path, { body: { name, ...fields } })
      // ⛔ A chave não entra na conversa (ficaria gravada nela): a pessoa a vê na tela, ao trocar.
      return reply(saved, (result) => {
        const { secret, ...hook } = result as { secret?: string } & Record<string, unknown>
        const { secretLast4: _last4, ...shown } = hook
        void _last4
        return { ...shown, ...(secret ? { key: `not shown here: open /agents/${agentId} → Hooks → "Trocar chave" to get a new key, shown once` } : {}) }
      })
    },
  )

  server.registerTool(
    'delete_hook',
    {
      description: 'Delete a hook and its key: the URL stops answering. Conversations it opened stay. Confirm with the person first.',
      inputSchema: { agentId: z.string(), name: z.string() },
    },
    async ({ agentId, name }) => reply(await api('DELETE', `/agents/${encodeURIComponent(agentId)}/hooks/${encodeURIComponent(name)}`)),
  )

  server.registerTool(
    'save_schedule',
    {
      description:
        'Create a schedule on an agent, or change the one with the same name (the name can\'t change). It runs as YOU, the person in this conversation, and spends tokens with nobody watching: confirm the text, the times and the mode with the person first. cron has 5 fields (minute hour day month weekday, e.g. "0 8 * * 1-5" = weekdays at 8:00); at least 5 minutes between runs. prompt is what the agent gets, as typed in the chat — "/command args" and "/skill request" work. session: new (one conversation per run) or continuous (the same conversation; the agent remembers previous runs). It pauses itself after 5 failures in a row.',
      inputSchema: {
        agentId: z.string(),
        name: z.string().describe('2–48 lowercase letters, digits or hyphens'),
        cron: z.string(),
        timezone: z.string().optional().describe('IANA; default America/Sao_Paulo'),
        prompt: z.string(),
        session: z.enum(['new', 'continuous']).optional(),
        projectId: z.string().nullable().optional().describe('Global agent only: the project its conversations run in'),
        enabled: z.boolean().optional(),
      },
    },
    async ({ agentId, name, ...fields }) => {
      const path = `/agents/${encodeURIComponent(agentId)}/schedules`
      const exists = ((await api('GET', path)).result as Array<{ name: string }> | undefined)?.some((schedule) => schedule.name === name)
      return reply(exists ? await api('PUT', `${path}/${encodeURIComponent(name)}`, { body: fields }) : await api('POST', path, { body: { name, ...fields } }))
    },
  )

  server.registerTool(
    'delete_schedule',
    {
      description: 'Delete a schedule and its run history. Conversations it opened stay. Confirm with the person first.',
      inputSchema: { agentId: z.string(), name: z.string() },
    },
    async ({ agentId, name }) => reply(await api('DELETE', `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(name)}`)),
  )

  server.registerTool(
    'install_package',
    {
      description:
        'Install a package into the persistent server tools folder (survives restarts; no root needed): from conda-forge by default, or from the npm registry with `source: "npm"` (then `version` is required and EXACT, e.g. 2.14.1, and install scripts do not run). Once installed, its commands work right away in every agent Bash, run_bash and local MCP (the folder is on the gateway PATH). One install at a time: a busy error means wait and retry. Confirm with the person before installing.',
      inputSchema: {
        name: z.string().describe('Exact name, from search_packages (npm: may be @scope/name)'),
        version: z.string().optional().describe('conda: e.g. 2.45 or 2.*, absent = newest; npm: exact, required'),
        source: z.enum(['conda', 'npm']).optional(),
      },
    },
    async ({ name, version, source }) => reply(await api('POST', '/packages', { body: { name, ...(version ? { version } : {}), ...(source ? { source } : {}) } })),
  )

  server.registerTool(
    'remove_package',
    {
      description: 'Uninstall a package from the server tools folder. Agents and local MCPs that call its commands stop finding them. Confirm with the person before removing.',
      inputSchema: { name: z.string(), source: z.enum(['conda', 'npm']).optional() },
    },
    async ({ name, source }) => reply(await api('DELETE', `/packages/${encodeURIComponent(name)}`, { query: { ...(source ? { source } : {}) } })),
  )

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
      description:
        'Create an agent, or replace the one with the same id: send every field, since an omitted adminOnly, sandbox or network falls back to its default (open to everyone, read-only, no network). Every problem comes back at once, field by field.',
      inputSchema: { ...agentShape, importedFrom },
    },
    async ({ importedFrom: source, ...agent }) => {
      // ⚖️ Sem trava própria: o MCP grava o que a tela grava, e quem decide o alcance do agente é o admin.
      const exists = (await api('GET', `/agents/${encodeURIComponent(agent.id)}`)).ok
      const saved = exists ? await api('PUT', `/agents/${encodeURIComponent(agent.id)}`, { body: agent }) : await api('POST', '/agents', { body: agent })
      return withImported(api, saved, source, (result) => ({ kind: 'agent', id: agent.id, ...(typeof result.projectId === 'string' ? { projectId: result.projectId } : {}) }))
    },
  )

  server.registerTool(
    'save_permission_rules',
    {
      description:
        "Add/remove permission rules of a target `{ scope: 'agent' | 'project', id }`. Restrictions (add deny, remove allow) apply now. Widenings (add allow, remove deny) stay PENDING until an administrator confirms on the screen; you cannot approve. Tell the person what is pending and where (the result says); never say access was granted before that.",
      inputSchema: {
        ...permissionTarget,
        add: z.array(permissionRuleShape).optional(),
        remove: z.array(permissionRuleShape).optional().describe('Must match existing rules.'),
        reason: z.string().describe('Why; shown to whoever confirms.'),
      },
    },
    async ({ scope, id, ...change }) => pendingReply(await api('POST', `${targetPath(scope, id)}/permission-rules`, { body: change })),
  )

  server.registerTool(
    'request_secret',
    {
      description:
        'Ask for a SECRET VARIABLE (a token, a password) by NAME for an agent, skill or command. ⛔ You never send or see the value: an administrator types it on the screen (account menu → Notificações). Tell the person what you asked and where; until then the variable does not exist.',
      inputSchema: {
        scope: z.enum(['agent', 'skill', 'command']),
        scopeId: z.string().describe('The agent id, or the skill/command id.'),
        name: z.string().describe('UPPERCASE_WITH_UNDERSCORES, e.g. GITLAB_TOKEN.'),
        description: z.string().optional().describe('What it is (shown with the variable).'),
        reason: z.string().describe('Why it is needed; shown to whoever fills it.'),
      },
    },
    async (body) => reply(await api('POST', '/secret-requests', { body })),
  )

  server.registerTool(
    'patch_agent',
    {
      description:
        'Change only some fields of an agent (same fields and rules as save_agent; null removes). What widens access (tools, delegation, permissions, exposure, sandbox…) stays PENDING until an administrator confirms on the screen; the rest applies now. Tell the person what is pending and where (the result says); never say it was granted before that.',
      inputSchema: {
        agentId: z.string(),
        patch: z.record(z.string(), z.unknown()).describe('Field → new value, e.g. { "allowedTools": [...] }.'),
        reason: z.string().describe('Why; shown to whoever confirms.'),
      },
    },
    async ({ agentId, patch, reason }) => pendingReply(await api('PATCH', `/agents/${encodeURIComponent(agentId)}`, { body: { patch, reason } })),
  )

  server.registerTool(
    'save_rule',
    {
      description:
        'Create an environment rule (without id: it goes to the end of its scope as the next Rule N), or change one (with id). It applies to conversations started from now on. Confirm the text with the person before saving.',
      inputSchema: {
        id: z.string().optional().describe('From list_rules; absent = a new rule'),
        projectId: z.string().nullable().optional().describe('The project it belongs to; null = global (every project). New rule: absent = global'),
        title: z.string().optional(),
        body: z.string().optional().describe('The rule itself, imperative and short'),
        enabled: z.boolean().optional(),
        tags: z.array(z.string()).optional().describe('Free words to group and filter in the lists (normalized to lowercase-hyphen); absent on update = keep, [] removes all'),
        importedFrom,
      },
    },
    async ({ id, importedFrom: source, ...rule }) =>
      withImported(api, id ? await api('PUT', `/rules/${encodeURIComponent(id)}`, { body: rule }) : await api('POST', '/rules', { body: rule }), source, (result) => ({
        kind: 'rule',
        id: String(result.id ?? id ?? ''),
        ...(typeof result.projectId === 'string' ? { projectId: result.projectId } : {}),
      })),
  )

  server.registerTool(
    'move_rule',
    {
      description:
        'Move an environment rule one position up or down within its scope (it swaps with its neighbour; at the end of the list it stays). Returns the scope in the new order. Call it once per step to move a rule further. Confirm the new order with the person first.',
      inputSchema: { id: z.string().describe('From list_rules'), direction: z.enum(['up', 'down']) },
    },
    async ({ id, direction }) => reply(await api('POST', `/rules/${encodeURIComponent(id)}/move`, { body: { direction } })),
  )

  server.registerTool(
    'delete_rule',
    { description: 'Delete an environment rule; the others of its scope are renumbered. Confirm with the person first.', inputSchema: { id: z.string() } },
    async ({ id }) => reply(await api('DELETE', `/rules/${encodeURIComponent(id)}`)),
  )

  server.registerTool(
    'save_doc',
    {
      description:
        'Create or replace a spec, ADR or knowledge study (markdown). The id is a slug (2–64 lowercase letters, digits or hyphens) that agents pass to read_doc; the summary is the one line shown in the conversation index. The status of an ADR goes in `status` (not in the text), and a decision that replaces others lists them in `supersedes`. A relation to another document (a spec citing a spec, an ADR pointing to a spec) is an attachment, never a path in the text: docIds lists the attached documents (global ones or of the same project; a global document attaches only global ones), which go along in full when this one is read; docRefs, which of them go by reference instead (id, title and size; read with read_doc only if needed). Absent on update = keep. Confirm with the person before saving.',
      inputSchema: {
        id: z.string(),
        kind: z.enum(['spec', 'adr', 'knowledge']),
        projectId: z.string().nullable().optional().describe('The project it belongs to; null or absent on a new one = global'),
        title: z.string().optional().describe('Required on a new one; absent on update = keep'),
        summary: z.string().optional().describe('Required on a new one; absent on update = keep'),
        body: z.string().optional().describe('Markdown. Required on a new one; absent on update = keep'),
        docIds: z.array(z.string()).optional().describe('Other documents attached to this one, in order'),
        docRefs: z.array(z.string()).optional().describe('Which of docIds go by reference instead of in full'),
        tags: z.array(z.string()).optional().describe('Free words to group and filter in the lists (normalized to lowercase-hyphen); absent on update = keep, [] removes all'),
        status: z
          .enum(['proposed', 'accepted', 'superseded', 'archived'])
          .optional()
          .describe(
            'Absent on a new one = accepted; on update = keep. Superseded and archived leave the conversation index and the initial context (search_docs and read_doc still find them, marked)',
          ),
        supersedes: z
          .array(z.string())
          .optional()
          .describe(
            'Documents this one replaces (same kind, same scope): saving marks each as superseded, and read_doc of them points here. Absent on update = keep; [] removes all',
          ),
        importedFrom,
      },
    },
    async ({ id, importedFrom: source, ...doc }) => {
      const exists = (await api('GET', `/docs/${encodeURIComponent(id)}`)).ok
      const saved = exists ? await api('PUT', `/docs/${encodeURIComponent(id)}`, { body: doc }) : await api('POST', '/docs', { body: { id, ...doc } })
      return withImported(api, saved, source, (result) => ({
        kind: String(result.kind ?? doc.kind),
        id,
        ...(typeof result.projectId === 'string' ? { projectId: result.projectId } : {}),
      }))
    },
  )

  server.registerTool(
    'set_initial_context',
    {
      description:
        'Replace the initial context of a project: the specs (only specs; global ones or of that project) that load IN FULL into every new conversation of it, in this order. Send the whole list; an empty list loads none. Everything loaded weighs on every conversation: mention the total tokens. Confirm with the person first.',
      inputSchema: { projectId: z.string(), docIds: z.array(z.string()).describe('Spec ids from list_docs, in prompt order') },
    },
    async ({ projectId, docIds }) => reply(await api('PUT', `/projects/${encodeURIComponent(projectId)}/initial-context`, { body: { docIds } })),
  )

  server.registerTool(
    'set_agent_initial_context',
    {
      description:
        "Replace the initial context of an agent: the specs (only specs) it loads IN FULL in every new conversation, on top of its project's, in this order. A project agent may use global specs and those of its project; a global agent only global ones. Send the whole list; empty = none. Mention the total tokens and confirm with the person first.",
      inputSchema: { agentId: z.string(), docIds: z.array(z.string()).describe('Spec ids from list_docs, in prompt order') },
    },
    async ({ agentId, docIds }) => reply(await api('PUT', `/agents/${encodeURIComponent(agentId)}/initial-context`, { body: { docIds } })),
  )

  server.registerTool(
    'attach_resource_files',
    {
      description:
        'Bring files (scripts, templates, data) INTO a skill, command or agent: the GATEWAY copies them on the server from a folder of the project — e.g. `repositories/logiccus/.agents/skills/business-bank-efi/scripts` (the old format) — you only point the path; you never read or write the content. Files land in the resource folder (`projects/<project>/skills/<id>/…`, `…/commands/<id>/…`, `…/agents/<id>/…`), which is READ-ONLY for agents: use_resource lists them with the absolute path, run them from there, cite them in the body by relative path (`scripts/balance.mjs`). Left out, with the reason: node_modules, .git, .env*, .credentials, private keys, binaries, files over 1 MB, and any file where the secret mask finds a secret — secrets are secret variables (request_secret), never files. Adds to the current list (same path replaces); `remove` drops paths or folders. Recorded in the catalog history. Confirm with the person first.',
      inputSchema: {
        scope: z.enum(['resource', 'agent']).describe('resource (a skill or command) or agent'),
        id: z.string().describe('The skill/command id, or the agent id.'),
        from: z.string().describe('A file or folder, relative to the PROJECT folder (e.g. repositories/<repo>/.agents/skills/<id>/scripts).'),
        to: z.string().optional().describe('Where inside the resource, e.g. scripts (default: the resource root).'),
        remove: z.array(z.string()).optional().describe('Paths (or folders) to drop from the resource.'),
        projectId: z.string().optional().describe('Only for a GLOBAL resource: the project whose folder holds `from`.'),
      },
    },
    async ({ scope, id, ...body }) => reply(await api('POST', `/${scope === 'agent' ? 'agents' : 'resources'}/${encodeURIComponent(id)}/files/import`, { body })),
  )

  server.registerTool(
    'save_resource',
    {
      description:
        'Create or replace a skill or a command. The id is a slug (2–48 lowercase letters, digits or hyphens) — the skill name in the index, the /name of the command. The description is the one line the agent reads to know when to use it. A command body is what goes to the agent; $ARGUMENTS takes what the person typed after /name. docIds: specs/ADRs that go along in full (global ones or of the same project); docRefs: which of them go by reference instead (listed with id, title and size, read with read_doc only if needed) — use it for large docs. triggers: the procedure of ONE situation inside the skill or command (never a separate skill): the loaded resource lists only id and when, and the agent loads the body with use_resource (kind trigger, id <resource>/<trigger>) when the situation happens. Absent on update = keep. By default every agent of its scope uses it (unless its Resources tab restricts). Confirm with the person first.',
      inputSchema: {
        id: z.string(),
        kind: z.enum(['skill', 'command']),
        projectId: z.string().nullable().optional().describe('The project; null or absent on a new one = global'),
        description: z.string().optional().describe('Required on a new one; absent on update = keep'),
        body: z.string().optional().describe('Skill: markdown. Command: the request, with $ARGUMENTS. Required on a new one; absent on update = keep'),
        docIds: z.array(z.string()).optional(),
        docRefs: z.array(z.string()).optional().describe('Which of docIds go by reference instead of in full'),
        triggers: z
          .array(z.object({ id: z.string().describe('Slug, unique in the resource'), when: z.string().describe('One line: the situation that fires it'), body: z.string() }))
          .optional()
          .describe('Absent on update = keep; [] removes all'),
        tags: z.array(z.string()).optional().describe('Free words to group and filter in the lists (normalized to lowercase-hyphen); absent on update = keep, [] removes all'),
        importedFrom,
      },
    },
    async ({ id, kind, importedFrom: source, ...resource }) => {
      const exists = (await api('GET', `/resources/${encodeURIComponent(id)}`)).ok
      const saved = exists ? await api('PUT', `/resources/${encodeURIComponent(id)}`, { body: resource }) : await api('POST', '/resources', { body: { id, kind, ...resource } })
      return withImported(api, saved, source, (result) => ({
        kind: String(result.kind ?? kind),
        id,
        ...(typeof result.projectId === 'string' ? { projectId: result.projectId } : {}),
      }))
    },
  )

  server.registerTool(
    'delete_resource',
    { description: 'Delete a skill or a command; agents lose it at once. Confirm with the person first.', inputSchema: { id: z.string() } },
    async ({ id }) => reply(await api('DELETE', `/resources/${encodeURIComponent(id)}`)),
  )

  server.registerTool(
    'set_agent_resources',
    {
      description:
        'Replace which skills and commands an agent may use: ids, or ["*"] = every global one plus those of its project (a global agent: only global ones). Send both lists; ["*"] = all (the default), an empty list = none on purpose. It applies to conversations started from now on. Confirm with the person first.',
      inputSchema: { agentId: z.string(), skills: z.array(z.string()), commands: z.array(z.string()) },
    },
    async ({ agentId, ...resources }) => reply(await api('PUT', `/agents/${encodeURIComponent(agentId)}/resources`, { body: resources })),
  )

  server.registerTool(
    'resolve_import_issue',
    {
      description:
        'Mark an import issue as resolved: it leaves the importIssues of the doc (spec, ADR, knowledge), skill, command or agent. Fix the cause first (attach the right document, adjust the text, release the skill). A PENDING issue (link-pending, skill-missing, command-missing, delegate-missing, mcp-missing) would come back by itself when a later import writes the target: resolving it DISCARDS it, and what it held back (the link, the agent rule) is forgotten — confirm with the person first. `target` picks one issue; absent = every issue with that code. Recorded in the catalog history.',
      inputSchema: {
        kind: z.enum(['doc', 'resource', 'agent']).describe('doc = spec, ADR or knowledge; resource = skill or command'),
        id: z.string(),
        code: z.string().describe('The issue code, e.g. link-not-document, link-pending, skill-missing, delegate-missing'),
        target: z.string().optional(),
      },
    },
    async ({ kind, id, code, target }) => {
      const base = kind === 'agent' ? '/agents' : kind === 'resource' ? '/resources' : '/docs'
      return reply(await api('POST', `${base}/${encodeURIComponent(id)}/import-issues/resolve`, { body: { code, ...(target ? { target } : {}) } }), savedEcho)
    },
  )

  server.registerTool(
    'delete_doc',
    { description: 'Delete a spec or ADR: it leaves the index of new conversations. Confirm with the person first.', inputSchema: { id: z.string() } },
    async ({ id }) => reply(await api('DELETE', `/docs/${encodeURIComponent(id)}`)),
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
  const api = callerApi(req)
  // A mesma regra da tela: só quem administra lê `/settings`.
  const admin = (await api('GET', '/settings')).ok
  const server = new McpServer({ name: 'agents-gateway', version: '1.0.0' })
  // ⚖️ Escrita LIGADA para admin por padrão (o Atlas precisa dela); `SELF_MCP_WRITE=0` desliga. A API, por
  // baixo, continua só deixando admin escrever.
  const agentId = req.headers[IDENTITY_HEADERS.agent]
  // ⚖️ EM FLUXO SÓ A CHAMADA QUE ESPERA TURNO, e só para cliente que aceita SSE: o resto segue em JSON, como sempre.
  const streaming = streamsTurn(req)
  registerTools(server, api, { admin, write: process.env.SELF_MCP_WRITE !== '0', streaming, ...(typeof agentId === 'string' && agentId.trim() ? { agentId: agentId.trim() } : {}) })

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !streaming })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}

/** A requisição é a chamada de uma ferramenta que espera turno, de um cliente que aceita SSE. */
export function streamsTurn(req: Pick<Request, 'headers' | 'body'>): boolean {
  if (!/\btext\/event-stream\b/.test(String(req.headers.accept ?? ''))) return false
  const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined
  return !Array.isArray(body) && body?.method === 'tools/call' && typeof body.params?.name === 'string' && TURN_TOOLS.has(body.params.name)
}

/** No modo sem estado não há stream nem sessão para abrir ou encerrar. */
export function rejectSelfMcp(_req: Request, res: Response): void {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP server is stateless; use POST.' }, id: null })
}
