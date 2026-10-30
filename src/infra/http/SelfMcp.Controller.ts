import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Request, Response } from 'express'
import { z } from 'zod'
import { ISelfReply, selfApi, selfBase, TSelfApi } from './Self.Api'

/** O que a própria API devolveu: o envelope `{ ok, result, message, code, details }` mais o status. */
/**
 * ⛔ Só o header da credencial (`X-Tool-Authorization`, a conta) de quem chamou o MCP segue adiante. Nada do
 * corpo do MCP vira identidade.
 */
function callerApi(req: Request): TSelfApi {
  const credentials: Record<string, string> = {}
  for (const name of ['x-tool-authorization']) {
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

/**
 * As ferramentas, segundo quem chama.
 *
 * ⛔ Ferramenta de admin NEM É REGISTRADA para quem não administra, e as de escrita só existem com
 * `SELF_MCP_WRITE=0` desligando — o cliente não vê o que não pode usar. A API, por baixo, recusaria de qualquer jeito.
 * ⛔ Chave de API e senha não passam por aqui: não há ferramenta para elas.
 */
function registerTools(server: McpServer, api: TSelfApi, access: { admin: boolean; write: boolean }) {
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

  server.registerTool(
    'start_conversation',
    {
      description:
        'Open a conversation with an agent. With `message`, also sends the first message and returns the reply. `metadata` is stored with the conversation (e.g. { accountId, userId }) for billing and filtering.',
      inputSchema: {
        agentId: z.string(),
        mode: z.enum(['chat', 'agent']).optional().describe('chat = plain SDK; agent = the provider Agents SDK.'),
        provider: z.string().optional().describe('One of the agent providers; default: the first that offers `model`.'),
        model: z.string().optional(),
        reasoning: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        projectId: z.string().optional().describe('For a global agent: the project the conversation belongs to. A project agent always opens in its own project.'),
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
    { description: 'One agent in full, system prompt included.', inputSchema: { agentId: z.string() }, annotations: { readOnlyHint: true } },
    async ({ agentId }) => reply(await api('GET', `/agents/${encodeURIComponent(agentId)}`)),
  )

  server.registerTool(
    'list_packages',
    {
      description:
        'The server tools installed from the Packages tab (micromamba, conda-forge) into a persistent folder on the PATH of every agent Bash, run_bash and local MCP. `explicit` = asked for; the rest came as dependencies.',
      annotations: { readOnlyHint: true },
    },
    async () => reply(await api('GET', '/packages')),
  )

  server.registerTool(
    'search_packages',
    {
      description:
        'Search conda-forge for a server tool by name (git, curl, jq, ffmpeg, ripgrep…): one hit per package, newest version, exact name first. The first search on a fresh server takes ~15s.',
      inputSchema: { query: z.string().min(2).max(100) },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => reply(await api('GET', '/packages/search', { query: { q: query } })),
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
    { description: 'One spec or ADR in full, markdown body included.', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => reply(await api('GET', `/docs/${encodeURIComponent(id)}`)),
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
        'The skills and commands of one scope, in full. A skill is a way of doing something that an agent loads with use_resource when the subject comes up; a command is a ready request the person fires with /name args (its body uses $ARGUMENTS). Both can carry specs/ADRs (docIds). Agents use all of their scope by default (global ones, plus those of their project); the Resources tab of an agent can restrict that. Absent projectId = the global ones.',
      inputSchema: { projectId: z.string().optional(), kind: z.enum(['skill', 'command']).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, kind }) => reply(await api('GET', '/resources', { query: { project: projectId ?? 'global', kind } })),
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
        'Install a conda-forge package into the persistent server tools folder (survives restarts; no root needed). Once installed, its commands work right away in every agent Bash, run_bash and local MCP (the folder is on the gateway PATH). One install at a time: a busy error means wait and retry. Confirm with the person before installing.',
      inputSchema: { name: z.string().describe('Exact conda-forge name, from search_packages'), version: z.string().optional().describe('e.g. 2.45 or 2.*; absent = newest') },
    },
    async ({ name, version }) => reply(await api('POST', '/packages', { body: { name, ...(version ? { version } : {}) } })),
  )

  server.registerTool(
    'remove_package',
    {
      description: 'Uninstall a package from the server tools folder. Agents and local MCPs that call its commands stop finding them. Confirm with the person before removing.',
      inputSchema: { name: z.string() },
    },
    async ({ name }) => reply(await api('DELETE', `/packages/${encodeURIComponent(name)}`)),
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
      inputSchema: agentShape,
    },
    async (agent) => {
      // ⚖️ Sem trava própria: o MCP grava o que a tela grava, e quem decide o alcance do agente é o admin.
      const exists = (await api('GET', `/agents/${encodeURIComponent(agent.id)}`)).ok
      return reply(exists ? await api('PUT', `/agents/${encodeURIComponent(agent.id)}`, { body: agent }) : await api('POST', '/agents', { body: agent }))
    },
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
      },
    },
    async ({ id, ...rule }) => reply(id ? await api('PUT', `/rules/${encodeURIComponent(id)}`, { body: rule }) : await api('POST', '/rules', { body: rule })),
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
        'Create or replace a spec, ADR or knowledge study (markdown). The id is a slug (2–64 lowercase letters, digits or hyphens) that agents pass to read_doc; the summary is the one line shown in the conversation index. For an ADR, write the status (Proposed, Accepted…) in the body. Confirm with the person before saving.',
      inputSchema: {
        id: z.string(),
        kind: z.enum(['spec', 'adr', 'knowledge']),
        projectId: z.string().nullable().optional().describe('The project it belongs to; null or absent on a new one = global'),
        title: z.string(),
        summary: z.string(),
        body: z.string().describe('Markdown'),
      },
    },
    async ({ id, ...doc }) => {
      const exists = (await api('GET', `/docs/${encodeURIComponent(id)}`)).ok
      return reply(exists ? await api('PUT', `/docs/${encodeURIComponent(id)}`, { body: doc }) : await api('POST', '/docs', { body: { id, ...doc } }))
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
    'save_resource',
    {
      description:
        'Create or replace a skill or a command. The id is a slug (2–48 lowercase letters, digits or hyphens) — the skill name in the index, the /name of the command. The description is the one line the agent reads to know when to use it. A command body is what goes to the agent; $ARGUMENTS takes what the person typed after /name. docIds: specs/ADRs that go along in full (global ones or of the same project); docRefs: which of them go by reference instead (listed with id, title and size, read with read_doc only if needed) — use it for large docs. By default every agent of its scope uses it (unless its Resources tab restricts). Confirm with the person first.',
      inputSchema: {
        id: z.string(),
        kind: z.enum(['skill', 'command']),
        projectId: z.string().nullable().optional().describe('The project; null or absent on a new one = global'),
        description: z.string(),
        body: z.string().describe('Skill: markdown. Command: the request, with $ARGUMENTS'),
        docIds: z.array(z.string()).optional(),
        docRefs: z.array(z.string()).optional().describe('Which of docIds go by reference instead of in full'),
      },
    },
    async ({ id, kind, ...resource }) => {
      const exists = (await api('GET', `/resources/${encodeURIComponent(id)}`)).ok
      return reply(exists ? await api('PUT', `/resources/${encodeURIComponent(id)}`, { body: resource }) : await api('POST', '/resources', { body: { id, kind, ...resource } }))
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
