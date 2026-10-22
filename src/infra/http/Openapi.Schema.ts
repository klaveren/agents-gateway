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
    reasoningEfforts: { type: 'array', items: { type: 'string' } },
    modes: { type: 'array', items: { type: 'string', enum: ['chat', 'agent'] } },
    allowedTools: { type: 'array', items: { type: 'string' } },
  },
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
    classifierModel: { type: 'string', description: 'Stored only for now: the turn classifier arrives in a later phase.' },
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
    '/agents': {
      get: {
        summary: 'The agent registry, including the lanes each agent supports. Requires a proven caller; never exposes the system prompt',
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: agentSchema })) }, '401': failures['401'] },
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
