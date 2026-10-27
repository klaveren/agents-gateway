/**
 * O contrato da API, publicado em `/v1/openapi.json`.
 *
 * Um documento escrito à mão vira mentira em duas semanas, então existe um teste que
 * compara este arquivo com a tabela de rotas do servidor e falha nos dois sentidos: rota
 * sem descrição e descrição sem rota.
 */

const envelope = (resultSchema: object) => ({
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    result: resultSchema,
  },
  required: ['ok'],
})

const failureEnvelope = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', enum: [false] },
    message: { type: 'string' },
    code: {
      type: 'string',
      enum: [
        'validation_error',
        'agent_not_found',
        'session_not_found',
        'mode_not_supported',
        'tools_not_supported',
        'adapter_not_found',
        'agent_unavailable',
        'agent_admin_only',
        'unauthorized',
        'not_found',
        'internal_error',
      ],
    },
    details: {},
  },
  required: ['ok', 'message', 'code'],
}

const sessionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    agentId: { type: 'string' },
    provider: { type: 'string', description: 'The provider answering now: one of the agent providers (it can switch mid-conversation).' },
    mode: { type: 'string', enum: ['chat', 'agent'] },
    model: { type: 'string' },
    reasoning: { type: 'string' },
    language: { type: 'string' },
    tools: { type: 'boolean' },
    status: { type: 'string', enum: ['idle', 'running'] },
    turns: { type: 'integer' },
    usage: {
      type: 'object',
      properties: {
        inputTokens: { type: 'integer', description: 'Whole input, cache included.' },
        outputTokens: { type: 'integer', description: 'Visible output only; reasoning is reported apart.' },
        reasoningTokens: { type: 'integer' },
        cacheReadTokens: { type: 'integer', description: 'Part of inputTokens read from the cache.' },
        cacheWriteTokens: { type: 'integer', description: 'Part of inputTokens written to the cache.' },
        contextTokens: {
          type: 'integer',
          description: 'Context in use: the input (cache included) of the LAST model call, not a sum. Absent when the provider does not report it (Codex, Antigravity).',
        },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    lastActivityAt: { type: 'string', format: 'date-time' },
    metadata: { type: 'object', description: '`owner` holds `id`, and `email` / `account` when the credential carries them.' },
  },
}

const usageSchema = sessionSchema.properties.usage

const classificationSchema = { type: 'string', enum: ['green', 'amber', 'red', 'blue'] }

const conversationSchema = {
  type: 'object',
  description: 'A persisted conversation (survives restarts), as opposed to a live session.',
  properties: {
    id: { type: 'string' },
    agentId: { type: 'string' },
    provider: { type: 'string' },
    mode: { type: 'string' },
    model: { type: 'string' },
    title: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    turns: { type: 'integer' },
    usage: usageSchema,
    metadata: { type: 'object', description: '`owner` holds `id`, and `email` / `account` when the credential carries them.' },
    shared: { type: 'boolean' },
    shareId: { type: 'string', description: 'The public link id, present while shared.' },
    preview: {
      type: 'object',
      description: 'The last turn, cut to 160 characters per side. Absent while the conversation has no turn.',
      properties: { at: { type: 'string', format: 'date-time' }, request: { type: 'string' }, text: { type: 'string' } },
    },
    classification: { ...classificationSchema, description: 'ADMIN responses only. The worst label among the turns.' },
    costUsd: { type: 'number', description: 'ADMIN responses only. Estimated; absent when the model has no known price (never zero).' },
  },
}

const turnSchema = {
  type: 'object',
  properties: {
    sessionId: { type: 'string' },
    index: { type: 'integer' },
    at: { type: 'string', format: 'date-time' },
    request: { type: 'string' },
    files: {
      type: 'array',
      description: 'What was attached: name, type and size only. The content is never stored.',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, mimeType: { type: 'string' }, size: { type: 'integer', description: 'Bytes, from the base64 length.' } },
      },
    },
    text: { type: 'string' },
    reasoning: { type: 'string' },
    toolCalls: { type: 'array', items: { type: 'object' } },
    usage: usageSchema,
    durationMs: { type: 'integer' },
    firstTextMs: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
    aborted: { type: 'boolean' },
    error: { type: 'string' },
    classification: { ...classificationSchema, description: 'ADMIN responses only.' },
    costUsd: { type: 'number', description: 'ADMIN responses only. Absent when the model has no known price.' },
  },
}

const sharedConversationSchema = {
  type: 'object',
  description: 'The public, read-only projection: no tool calls, reasoning, attachments, classification, usage or metadata.',
  properties: {
    id: { type: 'string', description: 'The shareId.' },
    title: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    turns: {
      type: 'array',
      items: { type: 'object', properties: { at: { type: 'string', format: 'date-time' }, request: { type: 'string' }, text: { type: 'string' } } },
    },
  },
}

const statsSchema = {
  type: 'object',
  properties: {
    conversations: { type: 'integer' },
    turns: { type: 'integer' },
    users: { type: 'integer', description: 'Distinct `metadata.owner.id`.' },
    accounts: { type: 'integer', description: 'Distinct `metadata.owner.account`.' },
    usage: usageSchema,
    costUsd: { type: 'number', description: 'Estimated, summing only the models with a known price: a floor when some model has none.' },
    byModel: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          model: { type: 'string' },
          conversations: { type: 'integer' },
          usage: usageSchema,
          costUsd: { type: 'number' },
        },
      },
    },
    byClassification: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Conversations per label; an absent key means none.' },
  },
}

const toolSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    origin: { type: 'string', enum: ['local', 'mcp'] },
    inputSchema: { type: 'object' },
  },
}

const toolsResult = {
  type: 'object',
  properties: {
    mcp: {
      type: 'object',
      properties: { url: { type: 'string' }, connected: { type: 'boolean' } },
    },
    tools: { type: 'array', items: toolSchema },
    native: {
      type: 'array',
      description:
        'SDK-native tools (Agents SDK lane only), by protocol. Store `id` in `allowedTools`. `server-*` risks run ON the gateway host (`dangerous: true`): whoever talks to the agent gets that reach, so mark the agent `adminOnly` when it is not for everyone.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          protocol: { type: 'string', enum: ['claude', 'openai', 'google'] },
          sdkName: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
          risk: { type: 'string', enum: ['hosted', 'session', 'server-network', 'server-read', 'server-exec'] },
          officialOnly: { type: 'boolean' },
          dangerous: { type: 'boolean', description: 'Reaches the gateway host (disk, network, shell).' },
        },
      },
    },
  },
}

const agentSchema = {
  type: 'object',
  description: 'Never carries the system prompt: the stored agent is projected, not passed through.',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    providers: {
      type: 'array',
      description: 'Where the agent runs. The first is the default; a live conversation can switch between them (`PATCH /sessions/{id}`).',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', description: 'The provider name as configured.' },
          protocol: { type: 'string' },
          models: { type: 'array', items: { type: 'string' } },
          contextLength: {
            type: 'object',
            description: 'Context window (tokens) of each model the provider reported one for, keyed by model id. Filled by refreshing the model list.',
            additionalProperties: { type: 'integer' },
          },
          pricing: {
            type: 'object',
            description:
              'Price per 1M tokens of each model this provider offers the agent that has a known price, keyed by model id. A model absent here has no known price (not zero); sort it last. Extend with `MODEL_PRICING_FILE`.',
            additionalProperties: {
              type: 'object',
              properties: {
                input: { type: 'number', description: 'USD per 1M fresh input tokens.' },
                output: { type: 'number', description: 'USD per 1M output tokens; reasoning is billed at this price.' },
                cacheRead: { type: 'number' },
                cacheWrite: { type: 'number' },
                introductoryUntil: { type: 'string', description: 'YYYY-MM-DD: the price is promotional until then.' },
              },
              required: ['input', 'output'],
            },
          },
          reasoningEfforts: { type: 'array', items: { type: 'string' }, description: 'The agent levels this provider protocol accepts, in its order.' },
          modelReasoning: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' }, nullable: true },
            description: 'Per model: the agent levels that model accepts. null = unknown (the provider levels apply); [] = the model does not reason.',
          },
          unavailable: { type: 'object', description: 'Admin only: why this provider does not run now.' },
        },
      },
    },
    reasoningEfforts: { type: 'array', items: { type: 'string' }, description: 'The levels the agent offers; each provider uses the ones its protocol accepts.' },
    modes: { type: 'array', items: { type: 'string', enum: ['chat', 'agent'] } },
    allowedTools: { type: 'array', items: { type: 'string' } },
    role: { type: 'string', enum: ['subagent'], description: 'Present on subagents: only called by another agent.' },
    adminOnly: { type: 'boolean', description: 'Present when only administrators can talk to the agent.' },
    projectId: { type: 'string', description: 'The project the agent belongs to. Absent = global (every project).' },
  },
}

const agentDetailSchema = {
  allOf: [
    agentSchema,
    {
      type: 'object',
      description: 'ADMIN only. The full agent, system prompt included.',
      properties: {
        systemPrompt: { type: 'string' },
        soul: { type: 'string', description: 'Who the agent is: identity, tone, values. Composed before the system prompt.' },
        updatedAt: { type: 'string', format: 'date-time' },
        updatedBy: { type: 'string' },
      },
    },
  ],
}

const agentBody = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,47}$', description: 'Creation only; on update the id comes from the path.' },
    name: { type: 'string' },
    providers: {
      type: 'array',
      minItems: 1,
      description: 'One or more configured providers, each with models ENABLED in its catalog. The first provider (and its first model) is the default.',
      items: {
        type: 'object',
        properties: { provider: { type: 'string' }, models: { type: 'array', items: { type: 'string' }, minItems: 1 } },
        required: ['provider', 'models'],
      },
    },
    systemPrompt: { type: 'string' },
    soul: { type: 'string', maxLength: 8000, description: 'Who the agent is (identity, tone, values); the system prompt says what it does.' },
    role: { type: ['string', 'null'], enum: ['subagent', null], description: '`subagent`: only called by another agent (delegation), never in a direct conversation.' },
    projectId: { type: ['string', 'null'], description: 'The project the agent belongs to: it works in that project folder and only its members see it. Absent or null = global.' },
    adminOnly: {
      type: 'boolean',
      description:
        'Only administrators can talk to the agent (and a delegation from a non-admin conversation cannot reach it). Absent or false = open to every account: subscriptions and server-reaching tools never close an agent on their own.',
    },
    reasoningEfforts: { type: 'array', items: { type: 'string' } },
    modes: { type: 'array', items: { type: 'string', enum: ['chat', 'agent'] } },
    allowedTools: {
      type: 'array',
      items: { type: 'string' },
      description: 'MCP tools, plus the local tools inside the `LOCAL_TOOLS_ENABLED` perimeter.',
    },
  },
  required: ['name', 'providers', 'systemPrompt', 'modes'],
}

const settingsSchema = {
  type: 'object',
  properties: {
    audience: {
      type: 'string',
      enum: ['off', 'restricted', 'all'],
      description:
        '`off`: nobody opens a new session. `restricted`: only callers whose PROVEN role is in `AUDIENCE_ROLES`. `all`: every caller the gateway lets through. Roles in `DENIED_ROLES` are refused under every value.',
    },
    agentId: { type: 'string', description: 'Agent that answers when the caller does not pick one (must be active). Absent = the first active agent that is not a subagent.' },
    provider: { type: 'string', description: 'Provider used when the caller sends none: one of the agent providers. Absent = the first that offers `model`.' },
    model: { type: 'string', description: "Model used when the caller sends none. A model the chosen agent does not declare falls back to the agent's default." },
    classifierModel: { type: 'string', description: 'Model that labels each turn — an enabled model of `classifierProvider`.' },
    classifierProvider: { type: 'string', description: 'Provider of the classifier model. Absent: inferred from the model id (official providers only).' },
    classifyTurns: { type: 'boolean', description: 'Stored only for now: the turn classifier arrives in a later phase.' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
  },
  required: ['audience'],
}

const settingsResult = {
  allOf: [
    settingsSchema,
    {
      type: 'object',
      description: 'What applies when an optional field is empty.',
      properties: {
        defaults: { type: 'object', properties: { agentId: { type: 'string' }, model: { type: 'string' } } },
      },
    },
  ],
}

const nullableText = { type: ['string', 'null'], description: 'Absent leaves it untouched. `null` (or an empty string) deletes it and reverts to the default.' }

const accessTokenSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    prefix: { type: 'string', description: 'The first characters, to recognize the token.' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    lastUsedAt: { type: 'string', format: 'date-time' },
    revokedAt: { type: 'string', format: 'date-time' },
  },
}

const mcpServerBody = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,31}$', description: 'Only on create.' },
    name: { type: 'string' },
    kind: {
      type: 'string',
      enum: ['remote', 'container', 'process'],
      description:
        'container = the gateway runs the image in an isolated container, one per conversation. process = a process of the gateway itself (npm package or command), with its reach, no isolation. Only on create.',
    },
    process: {
      type: 'object',
      description:
        'package (npm spec, installed by /install into <data>/mcp/<id>), command (the bin name, or without package a command on the PATH), args, env (secret variable names) and scope (conversation | shared).',
    },
    container: {
      type: 'object',
      description:
        'Image, args (`{proxy}` = the egress proxy URL), writable tmpfs paths, memoryMb, cpus, network (none | allowlist), allowedHosts (domains or {meta:key}) and env (secret variable names). Hardening (read-only, no capabilities, no volumes, no ports) is fixed.',
    },
    url: { type: 'string', description: 'http(s) URL of the MCP endpoint.' },
    transport: { type: 'string', enum: ['auto', 'http', 'sse'] },
    auth: { type: 'string', enum: ['caller', 'header', 'none'], description: 'caller = forward the conversing caller credential; header = a fixed secret header.' },
    headerName: { type: 'string', description: 'Header for auth: header (default Authorization).' },
    secret: { type: 'string', description: 'Only on create; later via /secret.' },
    enabled: { type: 'boolean', description: 'Only on update.' },
  },
}

const mcpServerSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
    transport: { type: 'string', enum: ['auto', 'http', 'sse'] },
    auth: { type: 'string', enum: ['caller', 'header', 'none'] },
    headerName: { type: 'string' },
    enabled: { type: 'boolean' },
    secret: { type: 'object', properties: { configured: { type: 'boolean' }, last4: { type: 'string' }, unreadable: { type: 'boolean' } } },
    status: { type: 'object', properties: { connected: { type: 'boolean' }, lastError: { type: 'string' } } },
    agents: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
    selfReference: { type: 'boolean', description: 'The URL is this gateway own /v1/mcp.' },
    install: { type: 'object', description: 'process only', properties: { installed: { type: 'boolean' }, version: { type: 'string' }, stale: { type: 'boolean' } } },
  },
}

const projectSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    folder: { type: 'string', description: 'Administrators only: the project folder on the server.' },
    members: { type: 'integer', description: 'Administrators only.' },
  },
}

const agentHookSchema = {
  type: 'object',
  properties: {
    agentId: { type: 'string' },
    name: { type: 'string' },
    path: { type: 'string', description: 'POST here to fire the hook: /v1/hook/<agentId>/<name>' },
    prompt: { type: 'string' },
    enabled: { type: 'boolean' },
    verify: { type: 'string', enum: ['key', 'hmac'] },
    signatureHeader: { type: 'string' },
    signaturePrefix: { type: 'string' },
    signatureEncoding: { type: 'string', enum: ['hex', 'base64'] },
    session: { type: 'string', enum: ['new', 'continuous'] },
    sessionId: { type: 'string' },
    runAs: { type: 'string', description: 'The account the agent runs as (whoever created the hook).' },
    secretLast4: { type: 'string' },
    secret: { type: 'string', description: 'Only on create and rotate. Never again.' },
  },
}

const agentHookBody = {
  type: 'object',
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,47}$', description: 'Only on create.' },
    prompt: { type: 'string', description: 'What the agent does when the event arrives; the event (body, useful headers, query) is appended.' },
    enabled: { type: 'boolean' },
    verify: {
      type: 'string',
      enum: ['key', 'hmac'],
      description: 'key = the hook key in Authorization: Bearer or X-Hook-Key; hmac = signature of the raw body with the key (GitHub style).',
    },
    signatureHeader: { type: 'string', description: 'hmac: default X-Hub-Signature-256' },
    signaturePrefix: { type: 'string', description: 'hmac: default sha256=' },
    signatureEncoding: { type: 'string', enum: ['hex', 'base64'] },
    session: { type: 'string', enum: ['new', 'continuous'], description: 'new = one conversation per call; continuous = all calls in one conversation, queued.' },
  },
}

const failures = {
  '401': {
    description:
      'Missing or invalid gateway bearer token; or no caller credential (`X-Tool-Authorization`) on any route but `/health` and `/shared/{id}`; or a credential that could not be proven (see `CALLER_PROOF_TOOL`, `REQUIRE_PROVEN_OWNER`). `ALLOW_ANONYMOUS=1` waives the missing-credential case.',
    content: { 'application/json': { schema: failureEnvelope } },
  },
  '403': {
    description:
      'Code `agent_unavailable`: the agent is not serving this caller right now (audience `off`, a role outside `AUDIENCE_ROLES` under `restricted`, or a role in `DENIED_ROLES`). An operating decision, not a missing permission to ask for. Code `agent_admin_only`: the agent was marked `adminOnly` by whoever created it.',
    content: { 'application/json': { schema: failureEnvelope } },
  },
  '404': {
    description:
      'Agent, session or conversation not found. One that belongs to someone else answers exactly like one that does not exist. Admin-only routes (`/settings`, `/conversations/stats`, `/conversations?scope=all`) answer 404 to everyone else, so their existence is not confirmed either.',
    content: { 'application/json': { schema: failureEnvelope } },
  },
  '422': { description: 'Validation failed', content: { 'application/json': { schema: failureEnvelope } } },
}

const json = (schema: object) => ({ content: { 'application/json': { schema } } })

const guidanceScope = { name: 'project', in: 'query', required: false, schema: { type: 'string' }, description: 'A project id; absent or `global` = the global scope.' }
const ruleSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    projectId: { type: 'string', description: 'Absent = global.' },
    position: { type: 'integer', description: 'The N of "Rule N" within its scope.' },
    title: { type: 'string' },
    body: { type: 'string' },
    enabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
  },
}
const ruleBody = {
  type: 'object',
  properties: {
    projectId: { type: 'string', nullable: true, description: 'The project; null = global. Changing it moves the rule to the end of the new scope.' },
    title: { type: 'string' },
    body: { type: 'string' },
    enabled: { type: 'boolean' },
  },
}
const docSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Slug; what agents pass to read_doc.' },
    kind: { type: 'string', enum: ['spec', 'adr'] },
    projectId: { type: 'string', description: 'Absent = global.' },
    title: { type: 'string' },
    summary: { type: 'string', description: 'One line: what the conversation index shows.' },
    body: { type: 'string', description: 'Markdown. Absent in the list.' },
    loadedIn: {
      type: 'object',
      description: 'List only: who loads this spec in full (their initial context).',
      properties: { projects: { type: 'array', items: { type: 'string' } }, agents: { type: 'array', items: { type: 'string' } } },
    },
    tokens: { type: 'integer', description: 'List only: estimated tokens of the body (≈ 4 characters per token).' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
  },
}
const docBody = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Only on create.' },
    kind: { type: 'string', enum: ['spec', 'adr'] },
    projectId: { type: 'string', nullable: true, description: 'The project; null = global.' },
    title: { type: 'string' },
    summary: { type: 'string' },
    body: { type: 'string' },
  },
}
const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
const resourceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Slug: the skill name in the index, the /name of a command.' },
    kind: { type: 'string', enum: ['skill', 'command'] },
    projectId: { type: 'string', description: 'Absent = global.' },
    description: { type: 'string', description: 'One line: what the agent (and the autocomplete) reads to know when to use it.' },
    body: { type: 'string', description: 'Skill: markdown. Command: the request sent to the agent; $ARGUMENTS takes what follows /name.' },
    docIds: { type: 'array', items: { type: 'string' }, description: 'Specs/ADRs that go along in full.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
  },
}
const agentResources = {
  type: 'object',
  properties: { skills: { type: 'array', items: { type: 'string' } }, commands: { type: 'array', items: { type: 'string' } } },
  description: 'Ids, or ["*"] = every global one plus those of the agent project (a global agent: only global ones).',
}
const initialContext = {
  type: 'object',
  properties: {
    docs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          projectId: { type: 'string', description: 'Absent = global.' },
          tokens: { type: 'integer', description: 'Estimated (≈ 4 characters per token).' },
        },
      },
    },
    totalTokens: { type: 'integer' },
  },
}

const usageTokens = {
  type: 'object',
  properties: {
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    reasoningTokens: { type: 'integer' },
    totalTokens: { type: 'integer' },
    cacheReadTokens: { type: 'integer' },
    cacheWriteTokens: { type: 'integer' },
  },
}
const usageFigure = (withCost: boolean) => ({
  type: 'object',
  properties: {
    conversations: { type: 'integer' },
    turns: { type: 'integer' },
    usage: usageTokens,
    ...(withCost ? { costUsd: { type: 'number' }, costIsFloor: { type: 'boolean', description: 'Some model has no known price: the cost is a floor.' } } : {}),
  },
})
const usageSummary = (withCost: boolean) => ({
  type: 'object',
  properties: {
    period: { type: 'object', properties: { days: { type: 'integer' }, since: { type: 'string', format: 'date-time' }, tzOffsetMinutes: { type: 'integer' } } },
    totals: usageFigure(withCost),
    daily: {
      type: 'array',
      items: { allOf: [usageFigure(withCost), { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD in the caller time zone.' } } }] },
    },
    byAgent: { type: 'array', items: { allOf: [usageFigure(withCost), { type: 'object', properties: { agentId: { type: 'string' } } }] } },
    byModel: { type: 'array', items: { allOf: [usageFigure(withCost), { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } }] } },
    top: {
      type: 'array',
      items: { allOf: [usageFigure(withCost), { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, agentId: { type: 'string' } } }] },
    },
  },
})
const usageParams = [
  { name: 'days', in: 'query', schema: { type: 'integer', enum: [7, 30, 90], default: 30 }, description: 'Period, counting today.' },
  { name: 'project', in: 'query', schema: { type: 'string' }, description: 'Only the conversations of this project (absent = all).' },
  { name: 'tz', in: 'query', schema: { type: 'integer' }, description: 'Minutes to add to UTC for local time (São Paulo: -180). Days are cut in this time zone.' },
]

const providerParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]

const providerStatusSchema = {
  type: 'object',
  description: 'A configured provider. NEVER the key itself: `credential` says where it comes from and its last four characters.',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    protocol: { type: 'string', enum: ['claude', 'openai', 'google'], description: 'Which SDK talks to it. Compatible providers speak `openai` or `claude` (Anthropic).' },
    baseUrl: { type: 'string', description: 'Compatible providers only.' },
    official: { type: 'boolean' },
    enabled: { type: 'boolean' },
    credential: {
      type: 'object',
      properties: {
        configured: { type: 'boolean' },
        source: { type: 'string', enum: ['stored', 'none'] },
        last4: { type: 'string' },
        updatedAt: { type: 'string', format: 'date-time' },
        updatedBy: { type: 'string' },
        unreadable: { type: 'boolean' },
      },
    },
    models: { type: 'array', items: { type: 'string' } },
    agents: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
  },
}

const loginSchema = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['idle', 'waiting', 'done', 'failed'] },
    url: { type: 'string' },
    userCode: { type: 'string' },
    needsCode: { type: 'boolean' },
    expiresAt: { type: 'string', format: 'date-time' },
    message: { type: 'string' },
  },
}

const catalogModelSchema = {
  type: 'object',
  properties: {
    modelId: { type: 'string' },
    label: { type: 'string' },
    enabled: { type: 'boolean', description: 'Can be offered by an agent. New models start disabled.' },
    available: { type: 'boolean', description: 'Seen in the last listing. False = it disappeared from the provider; kept, never deleted.' },
    contextLength: { type: 'integer' },
    price: {
      type: 'object',
      properties: { input: { type: 'number' }, output: { type: 'number' }, cacheRead: { type: 'number' }, cacheWrite: { type: 'number' } },
      description: 'USD per 1M tokens.',
    },
    priceSource: {
      type: 'string',
      enum: ['manual', 'catalog', 'default'],
      description: '`manual` wins and survives syncs; `catalog` came with the listing; `default` is the factory table (official providers only).',
    },
    reasoning: {
      type: 'object',
      properties: { supported: { type: 'boolean' }, levels: { type: 'array', items: { type: 'string' } }, source: { type: 'string', enum: ['provider', 'heuristic'] } },
      description: 'Whether the model reasons, from the provider listing. Absent = unknown. `heuristic` = guessed from the id (official OpenAI lists nothing).',
    },
    syncedAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
  },
}

const probeSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    unverified: { type: 'boolean', description: 'Answered, but the listing is public: the key is not proven yet.' },
    models: { type: 'integer' },
    status: { type: 'integer' },
    message: { type: 'string', description: 'The provider error, with the key masked.' },
  },
}

const userSchema = {
  type: 'object',
  description: 'A gateway account. The password hash never leaves the server.',
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'member'] },
    disabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
    lastLoginAt: { type: 'string', format: 'date-time' },
  },
}

const authSessionSchema = {
  type: 'object',
  description: 'Send `token` as `X-Tool-Authorization: Bearer <token>`. It stops working at once if the account is disabled or its role changes.',
  properties: { token: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' }, user: userSchema },
}

const passwordField = { type: 'string', minLength: 10, maxLength: 200 }
const userIdParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
const lastAdmin = {
  description: 'Invalid change, e.g. removing the last active administrator or disabling your own account. `details` lists `{ field, message }`',
  ...json(failureEnvelope),
}

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'agents-gateway',
    version: '1.0.0-alpha',
    description: 'Runs Claude, GPT and Gemini in two lanes: `chat` on the plain SDK, `agent` on the official Agents SDK.',
  },
  servers: [{ url: '/v1' }],
  components: {
    securitySchemes: {
      callerAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Tool-Authorization',
        description: "The caller's own credential, forwarded to the tools. Required on every route except `/health` and `/shared/{id}`; identifies the owner of a session.",
      },
    },
  },
  security: [{ callerAuth: [] }],
  paths: {
    '/health': {
      get: {
        summary: 'Liveness, MCP status and live session count',
        security: [],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'object' })) } },
      },
    },
    '/auth/status': {
      get: {
        summary: 'Whether local accounts exist and whether the first administrator still has to be created. Public',
        security: [],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { localAccounts: { type: 'boolean' }, setupRequired: { type: 'boolean' } } })) } },
      },
    },
    '/auth/setup': {
      post: {
        summary: 'Create the first administrator. Only with zero accounts, and only from this machine (loopback, no proxy). Public',
        security: [],
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' }, password: passwordField }, required: ['email', 'name', 'password'] }),
        },
        responses: {
          '201': { description: 'Created and signed in', ...json(envelope(authSessionSchema)) },
          '404': { description: 'Setup not available', ...json(failureEnvelope) },
          '422': failures['422'],
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Sign in with e-mail and password. One message for every failure; five failures lock the e-mail for 15 minutes. Public',
        security: [],
        requestBody: { required: true, ...json({ type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } }, required: ['email', 'password'] }) },
        responses: {
          '200': { description: 'Signed in', ...json(envelope(authSessionSchema)) },
          '401': { description: '`invalid_credentials`', ...json(failureEnvelope) },
          '429': { description: '`login_locked`, with `details.retryAfterSeconds`', ...json(failureEnvelope) },
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Sign out of EVERY session of the account: tokens issued before stop working, on any device',
        responses: { '200': { description: 'Signed out', ...json(envelope({ type: 'null' })) }, '401': failures['401'] },
      },
    },
    '/auth/me': {
      get: {
        summary: 'The account behind the current session',
        responses: { '200': { description: 'OK', ...json(envelope(userSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/auth/cookie': {
      post: {
        summary: 'Move the session sent in X-Tool-Authorization into the HttpOnly session cookie (migration for browsers that kept the token in storage)',
        responses: { '200': { description: 'Cookie set' }, '401': failures['401'], '422': failures['422'] },
      },
    },
    '/auth/password': {
      put: {
        summary: 'Change your own password; the current one is required',
        requestBody: { required: true, ...json({ type: 'object', properties: { current: { type: 'string' }, password: passwordField }, required: ['current', 'password'] }) },
        responses: {
          '200': { description: 'Changed. Every other session ends; this one continues with the session returned', ...json(envelope(authSessionSchema)) },
          '401': failures['401'],
          '422': failures['422'],
        },
      },
    },
    '/auth/tokens': {
      get: {
        summary: 'Your personal access tokens (name, prefix, dates). The token itself is never returned again',
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: accessTokenSchema })) }, '401': failures['401'] },
      },
      post: {
        summary:
          'Create a personal access token (`agw_…`) for scripts and MCP clients — sent in X-Tool-Authorization like a session token. It acts as your account (role changes apply; a disabled account stops it) and survives sign-out. Requires a signed-in session: an access token cannot create tokens',
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { name: { type: 'string', maxLength: 60 }, expiresInDays: { type: 'integer', minimum: 1, maximum: 365 } }, required: ['name'] }),
        },
        responses: {
          '201': {
            description: 'Created. `token` is shown only now',
            ...json(envelope({ allOf: [accessTokenSchema, { type: 'object', properties: { token: { type: 'string' } } }] })),
          },
          '401': failures['401'],
          '403': { description: 'Called with an access token', ...json(failureEnvelope) },
          '422': failures['422'],
        },
      },
    },
    '/auth/tokens/{id}': {
      delete: {
        summary: 'Revoke one of your access tokens. Requires a signed-in session',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Revoked', ...json(envelope({ type: 'null' })) },
          '401': failures['401'],
          '403': { description: 'Called with an access token', ...json(failureEnvelope) },
          '404': failures['404'],
        },
      },
    },
    '/users': {
      get: {
        summary: 'Every account. Administrators only; anyone else gets 404',
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: userSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary: 'Create an account with an initial password. Administrators only',
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: { email: { type: 'string' }, name: { type: 'string' }, password: passwordField, role: { type: 'string', enum: ['admin', 'member'], default: 'member' } },
            required: ['email', 'name', 'password'],
          }),
        },
        responses: { '201': { description: 'Created', ...json(envelope(userSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/users/{id}': {
      put: {
        summary: 'Rename, grant or revoke administrator, enable or disable. Accounts are never deleted: their conversations keep an owner. Administrators only',
        parameters: userIdParam,
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { name: { type: 'string' }, role: { type: 'string', enum: ['admin', 'member'] }, disabled: { type: 'boolean' } } }),
        },
        responses: { '200': { description: 'Updated', ...json(envelope(userSchema)) }, '401': failures['401'], '404': failures['404'], '422': lastAdmin },
      },
    },
    '/users/{id}/sessions': {
      delete: {
        summary: 'End every session of an account (a lost device, access that should have ended). Administrators only',
        parameters: userIdParam,
        responses: { '200': { description: 'Ended', ...json(envelope({ type: 'null' })) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/users/{id}/password': {
      post: {
        summary: "Set another account's password; that account's sessions end. Administrators only",
        parameters: userIdParam,
        requestBody: { required: true, ...json({ type: 'object', properties: { password: passwordField }, required: ['password'] }) },
        responses: { '200': { description: 'Set', ...json(envelope({ type: 'null' })) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/protocols': {
      get: {
        summary:
          'Every protocol and what a client needs from it: label, subscription, lanes, reasoning levels, native-tool family, brand, API-key console and the env variable imported once into the vault. Any authenticated caller',
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    subscription: { type: 'boolean' },
                    lanes: { type: 'array', items: { type: 'string', enum: ['chat', 'agent'] } },
                    reasoningLevels: { type: 'array', items: { type: 'string' } },
                    nativeFamily: { type: 'string' },
                    sandboxLevels: {
                      type: 'array',
                      items: { type: 'string', enum: ['read-only', 'workspace-write', 'full'] },
                      description: 'Sandbox levels an agent can pick, default first; empty = nothing to set.',
                    },
                    sandboxNetwork: { type: 'boolean', description: 'The sandbox opens the network apart (`network` on the agent provider).' },
                    brand: { type: 'string', enum: ['claude', 'openai', 'google'] },
                    consoleUrl: { type: 'string' },
                    envName: { type: 'string' },
                  },
                  required: ['id', 'label', 'subscription', 'lanes', 'reasoningLevels', 'nativeFamily', 'brand'],
                },
              }),
            ),
          },
          '401': failures['401'],
        },
      },
    },
    '/providers': {
      get: {
        summary: 'Each provider: whether a key is configured, where it comes from and what it unlocks. Administrators only; anyone else gets 404',
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: providerStatusSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary:
          'Add any OpenAI- or Anthropic-compatible provider: protocol `openai` or `claude`, an https base URL (http only for localhost), and optionally its key. Administrators only',
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,31}$' },
              name: { type: 'string' },
              protocol: { type: 'string', enum: ['openai', 'claude'] },
              baseUrl: { type: 'string' },
              key: { type: 'string' },
            },
            required: ['id', 'name', 'protocol', 'baseUrl'],
          }),
        },
        responses: { '201': { description: 'Created', ...json(envelope(providerStatusSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/providers/{id}': {
      put: {
        summary: 'Rename, enable or disable a provider; compatible ones can change their base URL. Administrators only',
        parameters: providerParam,
        requestBody: { required: true, ...json({ type: 'object', properties: { name: { type: 'string' }, baseUrl: { type: 'string' }, enabled: { type: 'boolean' } } }) },
        responses: { '200': { description: 'Updated', ...json(envelope(providerStatusSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Delete a compatible provider and its key. Official ones answer 422; one still used by an agent answers 409 `provider_in_use`. Administrators only',
        parameters: providerParam,
        responses: {
          '200': { description: 'Deleted', ...json(envelope({ type: 'null' })) },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: '`provider_in_use`, with `details.agents`', ...json(failureEnvelope) },
          '422': failures['422'],
        },
      },
    },
    '/providers/{id}/models': {
      get: {
        summary: "The provider's model catalog: everything it lists, enabled or not, with prices. Administrators only",
        parameters: providerParam,
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: catalogModelSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary:
          'Add a model by id (for providers without a listing, or a model the listing does not bring yet). It starts disabled, with the factory price suggested when there is one. Administrators only',
        parameters: providerParam,
        requestBody: { required: true, ...json({ type: 'object', properties: { modelId: { type: 'string' } }, required: ['modelId'] }) },
        responses: { '201': { description: 'Added', ...json(envelope(catalogModelSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      put: {
        summary:
          'Enable/disable one model and/or set its manual price (`price: null` reverts to the listing or factory price). The model id goes in the body because ids may contain `/`. Administrators only',
        parameters: providerParam,
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              modelId: { type: 'string' },
              enabled: { type: 'boolean' },
              price: {
                type: ['object', 'null'],
                properties: { input: { type: 'number' }, output: { type: 'number' }, cacheRead: { type: 'number' }, cacheWrite: { type: 'number' } },
              },
            },
            required: ['modelId'],
          }),
        },
        responses: { '200': { description: 'Updated', ...json(envelope(catalogModelSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/providers/{id}/login': {
      get: {
        summary: 'The subscription login in progress (ChatGPT via Codex, Google via Antigravity): link, device code and state. Administrators only',
        parameters: providerParam,
        responses: { '200': { description: 'OK', ...json(envelope(loginSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      post: {
        summary: "Start the client's official login in a home of the gateway's own; returns the link to open (and the device code). Administrators only",
        parameters: providerParam,
        responses: { '200': { description: 'Started', ...json(envelope(loginSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Cancel the login in progress. Administrators only',
        parameters: providerParam,
        responses: { '200': { description: 'Cancelled', ...json(envelope(loginSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/providers/{id}/login/code': {
      post: {
        summary: 'Hand the code the login page returned (Antigravity) to the waiting login. Administrators only',
        parameters: providerParam,
        requestBody: { required: true, ...json({ type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }) },
        responses: { '200': { description: 'Sent', ...json(envelope(loginSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/providers/{id}/models/sync': {
      post: {
        summary:
          "Fetch the provider's model listing and merge it: new models start disabled, enabling and manual prices are kept, missing ones are marked unavailable. Administrators only",
        parameters: providerParam,
        responses: {
          '200': {
            description: 'Synced',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  added: { type: 'integer' },
                  updated: { type: 'integer' },
                  missing: { type: 'integer' },
                  total: { type: 'integer' },
                  models: { type: 'array', items: catalogModelSchema },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': { description: 'No key saved for this provider', ...json(failureEnvelope) },
          '502': { description: '`upstream_error`: the provider listing failed (key masked)', ...json(failureEnvelope) },
        },
      },
    },
    '/providers/{id}/key': {
      put: {
        summary: 'Save the API key, encrypted at rest. It takes effect on the next call, with no restart, and is never returned. Administrators only',
        parameters: providerParam,
        requestBody: { required: true, ...json({ type: 'object', properties: { key: { type: 'string', minLength: 8, maxLength: 500 } }, required: ['key'] }) },
        responses: { '200': { description: 'Saved', ...json(envelope(providerStatusSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Remove the saved key; the environment key, if any, applies again. Administrators only',
        parameters: providerParam,
        responses: { '200': { description: 'Removed', ...json(envelope(providerStatusSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/providers/{id}/test': {
      post: {
        summary: 'Check a key with the cheapest authenticated call (list models): the one in the body, or the one in effect. Administrators only',
        parameters: providerParam,
        requestBody: { required: false, ...json({ type: 'object', properties: { key: { type: 'string' } } }) },
        responses: { '200': { description: 'The probe result', ...json(envelope(probeSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/mcp-servers': {
      get: {
        summary:
          'The MCP servers agents can use tools from: URL, transport, authentication (caller credential, a fixed secret header, or none), status and the agents using each. The secret is never returned. Administrators only',
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: mcpServerSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary: 'Register an MCP server. Agents then pick its tools as `mcp:<id>/<tool>` or `mcp:<id>/*`. Administrators only',
        requestBody: { required: true, ...json(mcpServerBody) },
        responses: { '201': { description: 'Created', ...json(envelope(mcpServerSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/mcp-servers/{id}': {
      put: {
        summary: 'Change an MCP server (name, URL, transport, authentication, header, enabled). Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json(mcpServerBody) },
        responses: { '200': { description: 'OK', ...json(envelope(mcpServerSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Remove an MCP server and its secret. 409 while an agent uses it. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Deleted', ...json(envelope({ type: 'null' })) },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: '`mcp_server_in_use`, with `details.agents`', ...json(failureEnvelope) },
        },
      },
    },
    '/mcp-servers/{id}/secret': {
      put: {
        summary: 'Save the secret header value (auth: header), encrypted. Never returned. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json({ type: 'object', properties: { secret: { type: 'string' } }, required: ['secret'] }) },
        responses: { '200': { description: 'Saved', ...json(envelope(mcpServerSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Remove the saved secret. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Removed', ...json(envelope(mcpServerSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/mcp-servers/{id}/test': {
      post: {
        summary: 'Connect now (ignoring the backoff) and count the tools. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { ok: { type: 'boolean' }, tools: { type: 'integer' }, message: { type: 'string' } } })) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/mcp-servers/{id}/env/{name}': {
      put: {
        summary: 'Save the value of a declared secret variable of a container MCP (encrypted; never returned). Administrators only',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, ...json({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }) },
        responses: { '200': { description: 'Saved', ...json(envelope(mcpServerSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/projects': {
      get: {
        summary:
          'The projects you can use (an administrator sees all, with the folder and member count). Agents and conversations belong to a project; models, MCP servers and packages are global',
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: projectSchema })) }, '401': failures['401'] },
      },
      post: {
        summary: 'Create a project and its folder (<data>/projects/<id>). Administrators only',
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,31}$' }, name: { type: 'string' }, description: { type: 'string' } },
            required: ['id', 'name'],
          }),
        },
        responses: { '201': { description: 'Created', ...json(envelope(projectSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/projects/{id}': {
      put: {
        summary: 'Change the name or description of a project (not its id). Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } }) },
        responses: { '200': { description: 'OK', ...json(envelope(projectSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Delete an empty project, its members and folder. Code project_in_use (409) while it still has agents. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Deleted' },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: 'Code project_in_use', content: { 'application/json': { schema: failureEnvelope } } },
        },
      },
    },
    '/projects/{id}/members': {
      get: {
        summary: 'The members of a project (account ids). Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(envelope({ type: 'array', items: { type: 'object', properties: { userId: { type: 'string' }, addedAt: { type: 'string', format: 'date-time' } } } })),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
      put: {
        summary: 'Replace the whole member list (anyone not listed leaves). Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json({ type: 'object', properties: { userIds: { type: 'array', items: { type: 'string' } } }, required: ['userIds'] }) },
        responses: { '200': { description: 'OK' }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/rules': {
      get: {
        summary:
          'The environment rules of one scope, in order. Every conversation gets the enabled ones in its system prompt when it starts: the global ones, then those of its project. Administrators only (404 for others)',
        parameters: [guidanceScope],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: ruleSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary: 'Create a rule at the end of its scope (the next Rule N). Administrators only',
        requestBody: { required: true, ...json({ ...ruleBody, required: ['title', 'body'] }) },
        responses: { '201': { description: 'Created', ...json(envelope(ruleSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/rules/{id}': {
      put: {
        summary: 'Change a rule; it applies to conversations started from now on. Administrators only',
        parameters: idParam,
        requestBody: { required: true, ...json(ruleBody) },
        responses: { '200': { description: 'OK', ...json(envelope(ruleSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Delete a rule; the rest of its scope is renumbered. Administrators only',
        parameters: idParam,
        responses: { '200': { description: 'OK' }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/rules/{id}/move': {
      post: {
        summary: 'Move a rule one position up or down in its scope; returns the scope in the new order. Administrators only',
        parameters: idParam,
        requestBody: { required: true, ...json({ type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] }) },
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: ruleSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/docs': {
      get: {
        summary:
          'The specs and ADRs of one scope, without the body. Conversations get an index (id, title, summary) of the global ones plus those of their project; agents read one with read_doc. Administrators only',
        parameters: [guidanceScope, { name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: ['spec', 'adr'] } }],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: docSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary: 'Create a spec or ADR (markdown). Administrators only',
        requestBody: { required: true, ...json({ ...docBody, required: ['id', 'kind', 'title', 'body'] }) },
        responses: { '201': { description: 'Created', ...json(envelope(docSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/docs/{id}': {
      get: {
        summary: 'One spec or ADR, body included. Administrators only',
        parameters: idParam,
        responses: { '200': { description: 'OK', ...json(envelope(docSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
      put: {
        summary: 'Change a spec or ADR (the id stays). Administrators only',
        parameters: idParam,
        requestBody: { required: true, ...json(docBody) },
        responses: { '200': { description: 'OK', ...json(envelope(docSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Delete a spec or ADR. Administrators only',
        parameters: idParam,
        responses: { '200': { description: 'OK' }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/agents/{agentId}/footprint': {
      get: {
        summary:
          'The size of an agent: what it carries before the first message, part by part, in estimated tokens (≈ 4 characters per token) — soul, instructions, rules, initial contexts, document index, local and MCP tools. SDK native tools are listed but not measured. For a global agent, `project` picks the conversation project. Administrators only',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'project', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  total: { type: 'integer' },
                  project: { type: 'string' },
                  sections: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        key: { type: 'string' },
                        label: { type: 'string' },
                        tokens: { type: 'integer', nullable: true, description: 'null = in the prompt, but not measurable here.' },
                        items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, tokens: { type: 'integer' } } } },
                        note: { type: 'string' },
                      },
                    },
                  },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/resources': {
      get: {
        summary: 'The skills and commands of one scope (`kind`, `project`; absent project or `global` = the global ones). Administrators only',
        parameters: [guidanceScope, { name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: ['skill', 'command'] } }],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: resourceSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary: 'Create a skill or a command. Administrators only',
        requestBody: { required: true, ...json({ ...resourceSchema, required: ['id', 'kind', 'description', 'body'] }) },
        responses: { '201': { description: 'Created', ...json(envelope(resourceSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/resources/{id}': {
      get: {
        summary: 'One skill or command. Administrators only',
        parameters: idParam,
        responses: { '200': { description: 'OK', ...json(envelope(resourceSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
      put: {
        summary: 'Change a skill or command (id and kind stay). Administrators only',
        parameters: idParam,
        requestBody: { required: true, ...json(resourceSchema) },
        responses: { '200': { description: 'OK', ...json(envelope(resourceSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Delete a skill or command. Administrators only',
        parameters: idParam,
        responses: { '200': { description: 'OK' }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/agents/{agentId}/resources': {
      get: {
        summary: 'The skills and commands an agent may use. Administrators only',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope(agentResources)) }, '401': failures['401'], '404': failures['404'] },
      },
      put: {
        summary: 'Replace the skills and commands an agent may use. Administrators only',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json(agentResources) },
        responses: { '200': { description: 'OK', ...json(envelope(agentResources)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/agents/{agentId}/commands': {
      get: {
        summary: 'The /commands the caller may use with this agent — id and description only (the composer autocomplete). Anyone who can talk to the agent',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' } } } })) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/agents/{agentId}/initial-context': {
      get: {
        summary: "The initial context of an agent: the specs it loads in full on top of its project's, in order. Administrators only",
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope(initialContext)) }, '401': failures['401'], '404': failures['404'] },
      },
      put: {
        summary:
          'Replace the initial context of an agent (the whole list, in prompt order). A project agent: global specs or of its project; a global agent: only global ones. Administrators only',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json({ type: 'object', properties: { docIds: { type: 'array', items: { type: 'string' } } }, required: ['docIds'] }) },
        responses: { '200': { description: 'OK', ...json(envelope(initialContext)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/projects/{id}/initial-context': {
      get: {
        summary:
          'The initial context of a project: the specs that go in full into the system prompt of every new conversation of it, next to the rules, in order. Specs not listed stay in the index (read_doc). Administrators only',
        parameters: idParam,
        responses: { '200': { description: 'OK', ...json(envelope(initialContext)) }, '401': failures['401'], '404': failures['404'] },
      },
      put: {
        summary: 'Replace the initial context (the whole list, in prompt order). Only specs, global or of this project. Administrators only',
        parameters: idParam,
        requestBody: { required: true, ...json({ type: 'object', properties: { docIds: { type: 'array', items: { type: 'string' } } }, required: ['docIds'] }) },
        responses: { '200': { description: 'OK', ...json(envelope(initialContext)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/hook/{agentId}/{hookName}': {
      post: {
        summary:
          'Fire an agent hook (public: the hook key is the credential). Any body; the agent runs the hook prompt with the event, as the account that created the hook. Answers 202 at once; the turn runs in the background',
        security: [],
        parameters: [
          ...[
            { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'hookName', in: 'path', required: true, schema: { type: 'string' } },
          ],
          { name: 'X-Hook-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: { required: false, content: { '*/*': { schema: {} } } },
        responses: {
          '202': {
            description: 'Accepted',
            ...json(envelope({ type: 'object', properties: { conversationId: { type: 'string' }, hook: { type: 'string' }, queued: { type: 'boolean' } } })),
          },
          '401': { description: 'Code hook_unauthorized: missing or wrong key or signature', content: { 'application/json': { schema: failureEnvelope } } },
          '404': failures['404'],
          '409': { description: 'Code hook_owner_inactive: the account the hook runs as is disabled or gone', content: { 'application/json': { schema: failureEnvelope } } },
          '429': { description: 'Too many calls to this hook (HOOK_RATE_LIMIT per minute)', content: { 'application/json': { schema: failureEnvelope } } },
        },
      },
    },
    '/agents/{agentId}/hooks': {
      get: {
        summary: "An agent's hooks. Administrators only",
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: agentHookSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary: 'Create a hook: it runs as you. The key comes back ONCE. Administrators only',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json(agentHookBody) },
        responses: { '201': { description: 'Created', ...json(envelope(agentHookSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/agents/{agentId}/hooks/{hookName}': {
      put: {
        summary: 'Change a hook (not its name). Administrators only',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'hookName', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, ...json(agentHookBody) },
        responses: { '200': { description: 'OK', ...json(envelope(agentHookSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Delete a hook and its key. Administrators only',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'hookName', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Deleted' }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/agents/{agentId}/hooks/{hookName}/rotate': {
      post: {
        summary: 'A new key for the hook; the old one stops working at once. The key comes back ONCE. Administrators only',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'hookName', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK', ...json(envelope(agentHookSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/agents/{agentId}/hooks/{hookName}/deliveries': {
      get: {
        summary: 'The last 20 calls of a hook: when, status (running, ok, error) and the conversation. Administrators only',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'hookName', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'array',
                items: {
                  type: 'object',
                  properties: { receivedAt: { type: 'string', format: 'date-time' }, status: { type: 'string' }, sessionId: { type: 'string' }, error: { type: 'string' } },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/packages': {
      get: {
        summary: 'Server tools installed by micromamba (conda-forge) into <data>/tools, which is on the PATH of everything the gateway runs. Administrators only',
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  available: { type: 'boolean', description: 'micromamba was found (MICROMAMBA_BIN or PATH)' },
                  version: { type: 'string' },
                  prefix: { type: 'string' },
                  packages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' }, explicit: { type: 'boolean' } } } },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
      post: {
        summary: 'Install a conda-forge package into <data>/tools (persistent). One operation at a time (409 package_busy). Administrators only',
        requestBody: { required: true, ...json({ type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' } }, required: ['name'] }) },
        responses: {
          '200': { description: 'ok false = micromamba failed; see log', ...json(envelope({ type: 'object', properties: { ok: { type: 'boolean' }, log: { type: 'string' } } })) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/packages/search': {
      get: {
        summary: 'Search conda-forge (`*q*`): one hit per name, newest version, exact name first, at most 30. Administrators only',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(envelope({ type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' }, license: { type: 'string' } } } })),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/packages/{name}': {
      delete: {
        summary: 'Uninstall a package from <data>/tools. Administrators only',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'ok false = micromamba failed; see log', ...json(envelope({ type: 'object', properties: { ok: { type: 'boolean' }, log: { type: 'string' } } })) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/mcp-servers/{id}/install': {
      post: {
        summary: 'npm install the package of a process MCP into its own folder, next to the previous install (kept if this one fails). Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK (ok false = npm failed; see log)',
            ...json(envelope({ type: 'object', properties: { ok: { type: 'boolean' }, version: { type: 'string' }, log: { type: 'string' }, server: mcpServerSchema } })),
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/mcp-servers/{id}/stop': {
      post: {
        summary: 'Stop every running instance (one per conversation, or the shared one) of a container or process MCP. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { stopped: { type: 'integer' } } })) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/mcp-proxy/{serverId}': {
      post: {
        summary:
          "Bridge used by the agentic SDK lanes to reach a container MCP: requires the conversation in X-Gateway-Session, owned by the caller, whose agent selected this server. Forwards tools/list and tools/call to that conversation's own isolated instance",
        parameters: [
          { name: 'serverId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'X-Gateway-Session', in: 'header', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'A JSON-RPC 2.0 message' } } } },
        responses: { '200': { description: 'JSON-RPC response', content: { 'application/json': { schema: { type: 'object' } } } }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/mcp-servers/{id}/tools': {
      get: {
        summary: 'The tools the server offers now (name, description, input schema). Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({ type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, inputSchema: { type: 'object' } } } }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/mcp': {
      post: {
        summary:
          'The gateway as an MCP server (Streamable HTTP, stateless, JSON responses): list_agents, start_conversation, send_message, switch_model, list_conversations, get_conversation, my_usage — plus, for administrators, usage_by_key, list_providers, list_models, list_tools, get_agent and — unless SELF_MCP_WRITE=0 — set_model_enabled, set_model_price and save_agent. Same credentials and rules as this API',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'A JSON-RPC 2.0 message' } } } },
        responses: { '200': { description: 'JSON-RPC response', content: { 'application/json': { schema: { type: 'object' } } } }, '401': failures['401'] },
      },
      get: { summary: 'Not available: the MCP server is stateless (405)', responses: { '405': { description: 'Method not allowed' } } },
      delete: { summary: 'Not available: the MCP server is stateless (405)', responses: { '405': { description: 'Method not allowed' } } },
    },
    '/usage/me': {
      get: {
        summary: "The signed-in caller's own usage: tokens per day, agent and model, and the heaviest conversations. Never carries cost",
        parameters: usageParams,
        responses: { '200': { description: 'OK', ...json(envelope(usageSummary(false))) }, '401': failures['401'] },
      },
    },
    '/usage/users': {
      get: {
        summary: 'Usage per user with estimated cost, most expensive first. Conversations without an owner come as one row with no `ownerId`. Administrators only',
        parameters: usageParams,
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  totals: usageFigure(true),
                  users: {
                    type: 'array',
                    items: { allOf: [usageFigure(true), { type: 'object', properties: { ownerId: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } } }] },
                  },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/usage/users/{ownerId}': {
      get: {
        summary: 'One user in detail, with cost (`anonymous` = conversations without an owner). Administrators only',
        parameters: [{ name: 'ownerId', in: 'path', required: true, schema: { type: 'string' } }, ...usageParams],
        responses: { '200': { description: 'OK', ...json(envelope(usageSummary(true))) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/usage/by/{key}': {
      get: {
        summary:
          'Usage grouped by the value of a session `metadata` key (e.g. `accountId`), with cost, most expensive first — the billing view for whoever integrates the gateway. Any other query parameter filters by metadata (`/usage/by/userId?accountId=xpto`). Metadata is declared by the session creator, not verified. Administrators only',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_]{1,64}$' } }, ...usageParams],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  totals: usageFigure(true),
                  groups: {
                    type: 'array',
                    items: { allOf: [usageFigure(true), { type: 'object', properties: { value: { type: 'string', description: 'Absent = conversations without the key.' } } }] },
                  },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': { description: 'Invalid metadata key (or `owner`, which has its own routes)', ...json(failureEnvelope) },
        },
      },
    },
    '/usage/by/{key}/{value}': {
      get: {
        summary: 'One value of a metadata key in detail, with cost (`~none` = conversations without the key). Administrators only',
        parameters: [
          { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'value', in: 'path', required: true, schema: { type: 'string' } },
          ...usageParams,
        ],
        responses: {
          '200': { description: 'OK', ...json(envelope(usageSummary(true))) },
          '401': failures['401'],
          '404': failures['404'],
          '422': { description: 'Invalid metadata key', ...json(failureEnvelope) },
        },
      },
    },
    '/agents': {
      post: {
        summary: 'Create an agent. Administrators only',
        requestBody: { required: true, ...json({ ...agentBody, required: [...agentBody.required, 'id'] }) },
        responses: {
          '201': { description: 'Created', ...json(envelope(agentDetailSchema)) },
          '401': failures['401'],
          '404': failures['404'],
          '422': { description: 'Invalid agent. `details` lists every problem as `{ field, message }`', ...json(failureEnvelope) },
        },
      },
      get: {
        summary:
          'The agents, including the lanes each supports. Members see only the active ones; admins see all, each inactive one with `unavailable`. With `project`, that project agents plus the global ones (404 for a project you cannot use); without it, everything you can use. Requires a proven caller; never exposes the system prompt',
        parameters: [{ name: 'project', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: agentSchema })) }, '401': failures['401'] },
      },
    },
    '/agents/{agentId}': {
      get: {
        summary: 'One agent in full, system prompt included. Administrators only; anyone else gets 404',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope(agentDetailSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
      put: {
        summary: 'Replace an agent. Administrators only. Live sessions keep the agent they started with',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json(agentBody) },
        responses: {
          '200': { description: 'The stored agent', ...json(envelope(agentDetailSchema)) },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: 'Built-in agent: read-only', ...json(failureEnvelope) },
          '422': { description: 'Invalid agent. `details` lists every problem as `{ field, message }`', ...json(failureEnvelope) },
        },
      },
      delete: {
        summary: 'Delete a created agent. Its recorded conversations stay. Administrators only',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Deleted', ...json(envelope({ type: 'null' })) },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: 'Built-in agent: read-only', ...json(failureEnvelope) },
        },
      },
    },
    '/agents/{agentId}/tools': {
      get: {
        summary: 'Tool catalog filtered by what the agent declares',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope(toolsResult)) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/tools': {
      get: {
        summary: 'Full tool catalog: built-in tools merged with whatever MCP exposes',
        responses: { '200': { description: 'OK', ...json(envelope(toolsResult)) }, '401': failures['401'] },
      },
    },
    '/availability': {
      get: {
        summary: 'Whether the agent serves the current caller right now. Yes or no only; any authenticated caller may ask',
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { available: { type: 'boolean' } }, required: ['available'] })) },
          '401': failures['401'],
        },
      },
    },
    '/settings': {
      get: {
        summary: 'Operating settings plus the defaults that apply to empty fields. Administrators only; anyone else gets 404',
        responses: { '200': { description: 'OK', ...json(envelope(settingsResult)) }, '401': failures['401'], '404': failures['404'] },
      },
      put: {
        summary: 'Partial update. Absent fields are untouched; `null` or an empty string on an optional field reverts it to the default. Administrators only',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  audience: { type: 'string', enum: ['off', 'restricted', 'all'], description: 'Required in storage: it cannot be cleared.' },
                  agentId: nullableText,
                  model: nullableText,
                  classifierModel: nullableText,
                  classifierProvider: nullableText,
                  classifyTurns: { type: ['boolean', 'null'] },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'The stored settings', ...json(envelope(settingsSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/conversations': {
      get: {
        summary: "List the caller's own persisted conversations, most recently updated first. `scope=all` (administrators only) lists everyone's",
        description:
          'Any other query key becomes an exact filter on `metadata` (plain identifiers only). Keys starting with `owner` are discarded: the owner comes from the credential, never from the query. `project` keeps one project (written by the server; 404 for a project you cannot use). With `scope=all` and `page`, the server paginates and searches.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['all'] }, description: 'Administrators only; anyone else gets 404.' },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 }, description: '`scope=all` only. Turns on server-side pagination.' },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 }, description: 'Searches title and owner e-mail, id and account (case-insensitive for ASCII).' },
          { name: 'classification', in: 'query', schema: classificationSchema },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          { name: 'agentId', in: 'query', schema: { type: 'string' }, description: '`scope=all` with `page` only.' },
        ],
        responses: {
          '200': {
            description: 'OK. The paginated form adds `total`, `page`, `pageSize`, `scope` and `facets` (counted over the search, not over the active tab).',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  sessions: { type: 'array', items: conversationSchema },
                  total: { type: 'integer' },
                  page: { type: 'integer' },
                  pageSize: { type: 'integer' },
                  scope: { type: 'string', enum: ['all'] },
                  facets: {
                    type: 'object',
                    properties: {
                      classification: { type: 'object', additionalProperties: { type: 'integer' } },
                      provider: { type: 'object', additionalProperties: { type: 'integer' } },
                      agent: { type: 'object', additionalProperties: { type: 'integer' } },
                    },
                  },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/conversations/stats': {
      get: {
        summary: 'Aggregate totals, by model and by classification, with the estimated cost. Administrators only; anyone else gets 404',
        responses: { '200': { description: 'OK', ...json(envelope(statsSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/conversations/events': {
      get: {
        summary: 'Live changes to persisted conversations (SSE). Administrators receive all of them; anyone else, only their own',
        description:
          'Events: `conversation.updated` with `{ session }` in the same projection as the listing (no `classification` or `costUsd` unless administrator), and `conversation.deleted` with `{ sessionId }`. A `: ping` comment every 15s keeps the connection open.',
        responses: { '200': { description: 'An event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } }, '401': failures['401'] },
      },
    },
    '/conversations/{id}/turns': {
      get: {
        summary: 'The turns of a persisted conversation. The owner or an administrator; anyone else gets 404. `costUsd` and `classification` appear only for administrators',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(envelope({ type: 'object', properties: { sessionId: { type: 'string' }, turns: { type: 'array', items: turnSchema } } })),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/conversations/{id}/share': {
      put: {
        summary: 'Open or close the conversation by link. The owner or an administrator; anyone else gets 404',
        description:
          'The shareId is created once (12 random bytes, base64url) and reused: closing keeps it and only stops `GET /shared/{id}` from answering, reopening returns the same link.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { shared: { type: 'boolean' } }, required: ['shared'] } } } },
        responses: {
          '200': {
            description: 'OK. `shareId` is present only while shared.',
            ...json(
              envelope({
                type: 'object',
                properties: { sessionId: { type: 'string' }, shared: { type: 'boolean' }, shareId: { type: 'string' } },
                required: ['sessionId', 'shared'],
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/conversations/{id}': {
      delete: {
        summary: 'Delete the persisted record (header and turns). The owner or an administrator. A live session, if any, keeps running: end it with `DELETE /sessions/{id}`',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'null' })) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/shared/{id}': {
      get: {
        summary: 'A conversation opened by link, read-only. PUBLIC: no caller credential needed (the gateway token still applies when set)',
        description: '`id` is the shareId, not the session id. A conversation that does not exist and one that is not shared both answer 404.',
        security: [],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope(sharedConversationSchema)) }, '404': failures['404'] },
      },
    },
    '/sessions': {
      post: {
        summary: 'Open a session on a lane',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  agentId: { type: 'string', description: 'Optional. Falls back to the configured agent (`PUT /settings`), then to the first active agent.' },
                  mode: { type: 'string', enum: ['chat', 'agent'], default: 'chat' },
                  tools: {
                    type: 'boolean',
                    default: false,
                    description: 'Chat lane only: run the hand-rolled tool loop. On the agent lane the SDK owns the loop.',
                  },
                  provider: { type: 'string', description: 'One of the agent providers (409 `provider_not_offered` otherwise). Absent: the first that offers `model`.' },
                  model: { type: 'string', description: "Falls back to the configured model; a model the agent does not declare falls back to the agent's default." },
                  reasoning: { type: 'string' },
                  language: { type: 'string' },
                  systemPrompt: { type: 'string' },
                  metadata: {
                    type: 'object',
                    description: 'Free-form. The `owner` and `project` keys are reserved: stamped by the server, and any sent here is discarded.',
                  },
                  projectId: {
                    type: 'string',
                    description:
                      'For a global agent: the project the conversation belongs to (you must be able to use it). A project agent always opens in its own project; 404 if you are not a member.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created. The session is owned by the caller (`metadata.owner`).', ...json(envelope(sessionSchema)) },
          '401': failures['401'],
          '403': failures['403'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
      get: {
        summary: "List the caller's own live sessions, most recently active first",
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: sessionSchema })) }, '401': failures['401'] },
      },
    },
    '/sessions/{id}': {
      get: {
        summary: 'Session state: lane, model, turns and accumulated usage',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope(sessionSchema)) }, '401': failures['401'], '404': failures['404'] },
      },
      patch: {
        summary:
          'Switch the provider, model and/or reasoning level of a live session, from the next turn on. Another provider of the agent receives a transcript of the previous turns; its internal state (tool ids, encrypted reasoning, cache) does not carry over',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  provider: { type: 'string', description: 'One of the agent providers. Absent = the current one.' },
                  model: { type: 'string', description: 'One of the models the agent offers now on that provider. Absent with a new provider = its first model.' },
                  reasoning: { type: 'string', nullable: true, description: 'A level of the provider protocol; null = provider default.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK', ...json(envelope(sessionSchema)) },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: 'The session is answering a turn (`session_busy`)', ...json(failureEnvelope) },
          '422': failures['422'],
        },
      },
      delete: {
        summary: 'End the session and release it, aborting anything in flight',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'null' })) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/sessions/{id}/messages': {
      post: {
        summary: 'Run a turn. Accept decides the format: SSE stream or aggregated JSON',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'Accept',
            in: 'header',
            schema: { type: 'string', enum: ['text/event-stream', 'application/json'], default: 'text/event-stream' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  files: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        mimeType: { type: 'string' },
                        data: { type: 'string', description: 'base64' },
                      },
                      required: ['name', 'mimeType', 'data'],
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The turn, streamed or aggregated',
            content: {
              'text/event-stream': { schema: { type: 'string' } },
              'application/json': { schema: envelope({ type: 'object' }) },
            },
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/sessions/{id}/cancel': {
      post: {
        summary: 'Abort the generation in flight, keeping the session',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'null' })) }, '401': failures['401'], '404': failures['404'] },
      },
    },
  },
} as const
