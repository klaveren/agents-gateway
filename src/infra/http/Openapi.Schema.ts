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
    provider: { type: 'string', enum: ['claude', 'openai', 'google'] },
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
      description: 'SDK-native tools (Agents SDK lane only), by protocol. Store `id` in `allowedTools`. `server-*` risks run ON the gateway host and are blocked unless listed in `NATIVE_TOOLS_ENABLED`.',
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
          allowed: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const agentSchema = {
  type: 'object',
  description: 'Never carries the system prompt: the registry entry is projected, not passed through.',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    provider: { type: 'string', enum: ['claude', 'openai', 'google'] },
    models: { type: 'array', items: { type: 'string' } },
    pricing: {
      type: 'object',
      description:
        'Price per 1M tokens of each model this agent offers that has a known price, keyed by model id. A model absent here has no known price (not zero); sort it last. Extend with `MODEL_PRICING_FILE`.',
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
    reasoningEfforts: { type: 'array', items: { type: 'string' }, description: 'The levels the provider protocol accepts, in its order.' },
    modelReasoning: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' }, nullable: true },
      description: 'Per model: the agent levels that model accepts. null = unknown (the agent levels apply); [] = the model does not reason.',
    },
    modes: { type: 'array', items: { type: 'string', enum: ['chat', 'agent'] } },
    allowedTools: { type: 'array', items: { type: 'string' } },
    builtIn: { type: 'boolean', description: 'Declared in code (read-only) or created through the API.' },
  },
}

const agentDetailSchema = {
  allOf: [
    agentSchema,
    {
      type: 'object',
      description: 'ADMIN only. The full agent, system prompt included.',
      properties: { systemPrompt: { type: 'string' }, updatedAt: { type: 'string', format: 'date-time' }, updatedBy: { type: 'string' } },
    },
  ],
}

const agentBody = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,47}$', description: 'Creation only; on update the id comes from the path.' },
    name: { type: 'string' },
    provider: { type: 'string', enum: ['claude', 'openai', 'google'] },
    systemPrompt: { type: 'string' },
    models: { type: 'array', items: { type: 'string' }, description: 'Every model must belong to `provider`.' },
    reasoningEfforts: { type: 'array', items: { type: 'string' } },
    modes: { type: 'array', items: { type: 'string', enum: ['chat', 'agent'] } },
    allowedTools: {
      type: 'array',
      items: { type: 'string' },
      description: 'MCP tools, plus the built-in tools some ENABLED built-in agent already has (the `AGENTS_ENABLED` perimeter).',
    },
  },
  required: ['name', 'provider', 'systemPrompt', 'models', 'modes'],
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
    agentId: { type: 'string', description: 'Registry agent that answers when the caller does not pick one. Absent = the registry default.' },
    model: { type: 'string', description: "Model used when the caller sends none. A model the chosen agent does not declare falls back to the agent's first." },
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

const failures = {
  '401': {
    description:
      'Missing or invalid gateway bearer token; or no caller credential (`X-Tool-Authorization`) on any route but `/health` and `/shared/{id}`; or a credential that could not be proven (see `CALLER_PROOF_TOOL`, `REQUIRE_PROVEN_OWNER`). `ALLOW_ANONYMOUS=1` waives the missing-credential case.',
    content: { 'application/json': { schema: failureEnvelope } },
  },
  '403': {
    description:
      'Code `agent_unavailable`: the agent is not serving this caller right now (audience `off`, a role outside `AUDIENCE_ROLES` under `restricted`, or a role in `DENIED_ROLES`). An operating decision, not a missing permission to ask for.',
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

const usageTokens = { type: 'object', properties: { inputTokens: { type: 'integer' }, outputTokens: { type: 'integer' }, reasoningTokens: { type: 'integer' }, totalTokens: { type: 'integer' }, cacheReadTokens: { type: 'integer' }, cacheWriteTokens: { type: 'integer' } } }
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
    daily: { type: 'array', items: { allOf: [usageFigure(withCost), { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD in the caller time zone.' } } }] } },
    byAgent: { type: 'array', items: { allOf: [usageFigure(withCost), { type: 'object', properties: { agentId: { type: 'string' } } }] } },
    byModel: { type: 'array', items: { allOf: [usageFigure(withCost), { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } }] } },
    top: { type: 'array', items: { allOf: [usageFigure(withCost), { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, agentId: { type: 'string' } } }] } },
  },
})
const usageParams = [
  { name: 'days', in: 'query', schema: { type: 'integer', enum: [7, 30, 90], default: 30 }, description: 'Period, counting today.' },
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
        source: { type: 'string', enum: ['stored', 'env', 'none'] },
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

const catalogModelSchema = {
  type: 'object',
  properties: {
    modelId: { type: 'string' },
    label: { type: 'string' },
    enabled: { type: 'boolean', description: 'Can be offered by an agent. New models start disabled.' },
    available: { type: 'boolean', description: 'Seen in the last listing. False = it disappeared from the provider; kept, never deleted.' },
    contextLength: { type: 'integer' },
    price: { type: 'object', properties: { input: { type: 'number' }, output: { type: 'number' }, cacheRead: { type: 'number' }, cacheWrite: { type: 'number' } }, description: 'USD per 1M tokens.' },
    priceSource: { type: 'string', enum: ['manual', 'catalog', 'default'], description: '`manual` wins and survives syncs; `catalog` came with the listing; `default` is the factory table (official providers only).' },
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
  properties: { ok: { type: 'boolean' }, unverified: { type: 'boolean', description: 'Answered, but the listing is public: the key is not proven yet.' }, models: { type: 'integer' }, status: { type: 'integer' }, message: { type: 'string', description: 'The provider error, with the key masked.' } },
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
const lastAdmin = { description: 'Invalid change, e.g. removing the last active administrator or disabling your own account. `details` lists `{ field, message }`', ...json(failureEnvelope) }

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
      bearerAuth: { type: 'http', scheme: 'bearer', description: "The gateway's own gate, enforced only when `GATEWAY_TOKEN` is set." },
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
        requestBody: { required: true, ...json({ type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' }, password: passwordField }, required: ['email', 'name', 'password'] }) },
        responses: { '201': { description: 'Created and signed in', ...json(envelope(authSessionSchema)) }, '404': { description: 'Setup not available', ...json(failureEnvelope) }, '422': failures['422'] },
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
    '/auth/password': {
      put: {
        summary: 'Change your own password; the current one is required',
        requestBody: { required: true, ...json({ type: 'object', properties: { current: { type: 'string' }, password: passwordField }, required: ['current', 'password'] }) },
        responses: { '200': { description: 'Changed. Every other session ends; this one continues with the session returned', ...json(envelope(authSessionSchema)) }, '401': failures['401'], '422': failures['422'] },
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
          ...json({ type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' }, password: passwordField, role: { type: 'string', enum: ['admin', 'member'], default: 'member' } }, required: ['email', 'name', 'password'] }),
        },
        responses: { '201': { description: 'Created', ...json(envelope(userSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/users/{id}': {
      put: {
        summary: 'Rename, grant or revoke administrator, enable or disable. Accounts are never deleted: their conversations keep an owner. Administrators only',
        parameters: userIdParam,
        requestBody: { required: true, ...json({ type: 'object', properties: { name: { type: 'string' }, role: { type: 'string', enum: ['admin', 'member'] }, disabled: { type: 'boolean' } } }) },
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
    '/providers': {
      get: {
        summary: 'Each provider: whether a key is configured, where it comes from and what it unlocks. Administrators only; anyone else gets 404',
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: providerStatusSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary: 'Add any OpenAI- or Anthropic-compatible provider: protocol `openai` or `claude`, an https base URL (http only for localhost), and optionally its key. Administrators only',
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,31}$' }, name: { type: 'string' }, protocol: { type: 'string', enum: ['openai', 'claude'] }, baseUrl: { type: 'string' }, key: { type: 'string' } },
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
      put: {
        summary: 'Enable/disable one model and/or set its manual price (`price: null` reverts to the listing or factory price). The model id goes in the body because ids may contain `/`. Administrators only',
        parameters: providerParam,
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: { modelId: { type: 'string' }, enabled: { type: 'boolean' }, price: { type: ['object', 'null'], properties: { input: { type: 'number' }, output: { type: 'number' }, cacheRead: { type: 'number' }, cacheWrite: { type: 'number' } } } },
            required: ['modelId'],
          }),
        },
        responses: { '200': { description: 'Updated', ...json(envelope(catalogModelSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/providers/{id}/models/sync': {
      post: {
        summary: "Fetch the provider's model listing and merge it: new models start disabled, enabling and manual prices are kept, missing ones are marked unavailable. Administrators only",
        parameters: providerParam,
        responses: {
          '200': { description: 'Synced', ...json(envelope({ type: 'object', properties: { added: { type: 'integer' }, updated: { type: 'integer' }, missing: { type: 'integer' }, total: { type: 'integer' }, models: { type: 'array', items: catalogModelSchema } } })) },
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
    '/mcp': {
      post: {
        summary:
          'The gateway as an MCP server (Streamable HTTP, stateless, JSON responses): list_agents, start_conversation, send_message, switch_model, list_conversations, get_conversation, my_usage — plus, for administrators, usage_by_key, list_providers, list_models, get_agent and (with SELF_MCP_WRITE=1) set_model_enabled and save_agent. Same credentials and rules as this API',
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
                  users: { type: 'array', items: { allOf: [usageFigure(true), { type: 'object', properties: { ownerId: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } } }] } },
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
                  groups: { type: 'array', items: { allOf: [usageFigure(true), { type: 'object', properties: { value: { type: 'string', description: 'Absent = conversations without the key.' } } }] } },
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
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'value', in: 'path', required: true, schema: { type: 'string' } }, ...usageParams],
        responses: { '200': { description: 'OK', ...json(envelope(usageSummary(true))) }, '401': failures['401'], '404': failures['404'], '422': { description: 'Invalid metadata key', ...json(failureEnvelope) } },
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
        summary: 'The agent registry, including the lanes each agent supports. Requires a proven caller; never exposes the system prompt',
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
        summary: 'Replace a created agent. Built-in agents answer 409 `agent_read_only`. Administrators only. Live sessions keep the agent they started with',
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
          'Any other query key becomes an exact filter on `metadata` (plain identifiers only). Keys starting with `owner` are discarded: the owner comes from the credential, never from the query. With `scope=all` and `page`, the server paginates and searches.',
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
                  agentId: { type: 'string', description: 'Optional. Falls back to the configured agent (`PUT /settings`), then to the registry default.' },
                  mode: { type: 'string', enum: ['chat', 'agent'], default: 'chat' },
                  tools: {
                    type: 'boolean',
                    default: false,
                    description: 'Chat lane only: run the hand-rolled tool loop. On the agent lane the SDK owns the loop.',
                  },
                  model: { type: 'string', description: "Falls back to the configured model; a model the agent does not declare falls back to the agent's first." },
                  reasoning: { type: 'string' },
                  language: { type: 'string' },
                  systemPrompt: { type: 'string' },
                  metadata: {
                    type: 'object',
                    description: 'Free-form. The `owner` key is reserved: it is stamped from the caller credential and any `owner` sent here is discarded.',
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
        summary: 'Switch the model and/or the reasoning level of a live session, from the next turn on',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  model: { type: 'string', description: 'One of the models the agent offers now (same provider).' },
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
