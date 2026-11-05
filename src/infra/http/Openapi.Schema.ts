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
    place: {
      type: 'object',
      description: 'Only on GET /sessions/{id}, for a conversation opened in a repository: where it works now.',
      properties: { repository: { type: 'string' }, worktree: { type: 'string' }, branch: { type: 'string' } },
    },
    turns: { type: 'integer' },
    compactNext: { type: 'boolean', description: 'Compaction was asked for and runs at the start of the next turn.' },
    compactsItself: { type: 'boolean', description: 'The lane compacts its own context (Codex, Antigravity): the gateway does not.' },
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
    modelGroup: {
      type: 'string',
      description:
        'The model group (Settings → model groups) the agent switches through when a model fails, and starts in when no model is picked. Absent = the default group; `none` = no switching.',
    },
    projectId: { type: 'string', description: 'The project the agent belongs to. Absent = global (every project).' },
    importIssueCount: { type: 'integer', description: 'List, administrators only: how many import issues the agent has (the detail lists them). Absent = none.' },
  },
}

/** Os problemas da importação que ficam no artefato (doc, skill, command, agente): não impediram a gravação. */
const importIssuesSchema = {
  type: 'array',
  description:
    'Import issues: problems the importer recorded in the artifact instead of blocking the write (a citation that is not a document, a link still pending, a skill not imported yet, an agent rule that releases delegating to an agent or using an MCP server that does not exist). Only the importer adds them; a normal edit keeps them; POST …/import-issues/resolve removes one (or, with `{ pending: true }`, every pending one). The PENDING ones — `link-pending`, `skill-missing`, `command-missing`, `delegate-missing`, `mcp-missing` — resolve by themselves when a later import writes the target: the link (or the held-back rule) comes back in that write, and a rule that comes back is a widening to confirm like any other. Discarding a pending issue forgets what was held back.',
  items: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        enum: ['link-not-document', 'link-not-spec', 'link-missing', 'link-scope', 'link-pending', 'skill-missing', 'command-missing', 'delegate-missing', 'mcp-missing'],
      },
      message: { type: 'string', description: 'In Portuguese, for the person and for the agent that fixes it.' },
      target: { type: 'string', description: 'The id the link cited.' },
      link: {
        type: 'string',
        enum: ['attach', 'reference', 'initialContext', 'skill', 'command', 'reach'],
        description: 'The link left out (what comes back by itself). `reach`: the agent permissions and allowedTools in `rules` and `tools`.',
      },
      rules: {
        type: 'array',
        description:
          '`delegate-missing`/`mcp-missing`: the exact agent permission rules held back (allow rules naming a specific agent or MCP server; deny and wildcard rules stay).',
        items: {
          type: 'object',
          properties: { category: { type: 'string' }, pattern: { type: 'string' }, decision: { type: 'string', enum: ['allow', 'deny'] }, note: { type: 'string' } },
          required: ['category', 'pattern', 'decision'],
        },
      },
      tools: { type: 'array', items: { type: 'string' }, description: 'The allowedTools entries held back (`agent:<id>`, `mcp:<server>/<tool>`).' },
    },
    required: ['code', 'message'],
  },
}
const importIssueMatch = {
  oneOf: [
    {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The issue code' },
        target: { type: 'string', description: 'Only the issue with this target; absent = every issue with the code' },
      },
      required: ['code'],
    },
    {
      type: 'object',
      description:
        'DISCARD every pending issue at once (`link-pending`, `skill-missing`, `command-missing`, `delegate-missing`, `mcp-missing`): one write, one revision in the history; what they held back is forgotten',
      properties: { pending: { type: 'boolean', enum: [true] } },
      required: ['pending'],
    },
  ],
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
        importIssues: importIssuesSchema,
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
    soul: {
      type: 'string',
      description:
        'Who the agent is (identity, tone, values); the system prompt says what it does. No size cap: it costs tokens every turn. Agents on Codex or Antigravity keep soul + prompt under 120 KB (Linux command-line argument limit)',
    },
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
    builderProvider: { type: 'string', description: 'Provider of the builder (the core agent that drafts skills and commands). Absent: the one of Atlas.' },
    builderModel: { type: 'string', description: 'Model of the builder — an enabled model of `builderProvider`. Absent: the one of Atlas.' },
    classifyTurns: { type: 'boolean', description: 'Stored only for now: the turn classifier arrives in a later phase.' },
    modelGroups: {
      type: 'array',
      maxItems: 50,
      description:
        'Model groups: ordered steps (provider + model) and switch rules. When a model fails for a reason the group switches on (quota, rate limit, model unavailable…), the conversation moves to the next available step and STAYS there. A conversation opened without a model starts at the first available step. Agents point to one (`modelGroup`).',
      items: {
        type: 'object',
        required: ['id', 'name', 'steps'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,47}$' },
          name: { type: 'string', maxLength: 80 },
          description: { type: 'string', maxLength: 500 },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: { type: 'object', required: ['provider', 'model'], properties: { provider: { type: 'string' }, model: { type: 'string' } } },
          },
          switchOn: { type: 'array', items: { type: 'string', enum: ['quota', 'rate_limit', 'model', 'overloaded', 'auth'] }, description: 'Default: quota, rate_limit, model.' },
          cooldownMinutes: {
            type: 'integer',
            minimum: 1,
            maximum: 1440,
            description: 'How long a failed step stays aside when the error does not say when it resets. Default 15.',
          },
        },
      },
    },
    defaultModelGroup: { type: 'string', description: 'The group of agents that point to none. Absent = no group: a failing model ends the turn.' },
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
    projectId: {
      type: ['string', 'null'],
      description:
        'The owning project (absent = global). A project server serves only agents of that project. Two projects may share an id; a project id never collides with a global one. On update, a project or null (global) moves it — refused (409) if an agent would lose it.',
    },
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
    identity: { type: 'boolean', description: 'Send who calls (x-gateway-agent, x-gateway-conversation, x-gateway-project headers). Default false' },
    secret: { type: 'string', description: 'Only on create; later via /secret.' },
    enabled: { type: 'boolean', description: 'Only on update.' },
  },
}

const mcpServerSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'The path key: the id for a global server, <projectId>.<id> for a project one.' },
    id: { type: 'string' },
    projectId: { type: 'string', description: 'Absent = global.' },
    name: { type: 'string' },
    url: { type: 'string' },
    transport: { type: 'string', enum: ['auto', 'http', 'sse'] },
    auth: { type: 'string', enum: ['caller', 'header', 'none'] },
    headerName: { type: 'string' },
    identity: { type: 'boolean' },
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

const catalogKinds = ['agent', 'skill', 'command', 'rule', 'spec', 'adr', 'knowledge', 'protocol', 'project', 'project-permissions', 'mcp']
const catalogItemParams = [
  { name: 'kind', in: 'query', required: true, schema: { type: 'string', enum: catalogKinds } },
  {
    name: 'id',
    in: 'query',
    required: true,
    schema: { type: 'string' },
    description:
      'The item id. MCP: the server key (`n8n` global, `cliente-a.n8n` of project `cliente-a`). Protocol addendum: the kind (`skill`) or `<project>/<kind>`. Rule: the uuid. Project and project-permissions: the project id.',
  },
  {
    name: 'project',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description:
      'Completes the key when needed: `kind=mcp&id=n8n&project=cliente-a` is `cliente-a.n8n`; `kind=protocol&id=skill&project=cliente-a` is `cliente-a/skill`. Ignored by the other kinds.',
  },
]
const historyPaging = [
  { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'pageSize', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
]
const revisionFields = {
  id: { type: 'integer' },
  kind: { type: 'string', enum: catalogKinds },
  itemId: { type: 'string', description: 'The item id (MCP: the server key).' },
  projectId: { type: 'string', description: 'The scope AT this revision. Absent = global.' },
  revision: { type: 'integer', description: '1..n per item.' },
  op: { type: 'string', enum: ['baseline', 'create', 'update', 'delete', 'restore', 'import', 'drift'] },
  hash: { type: 'string', description: 'sha256 of the canonical document. Absent on `delete`.' },
  at: { type: 'string', format: 'date-time' },
  by: { type: 'string' },
  source: { type: 'string', enum: ['api', 'agent', 'migration', 'boot', 'import', 'restore'] },
  batchId: { type: 'string' },
  note: { type: 'string' },
  widenings: { type: 'array', items: { type: 'string' }, description: 'The keys of the access widenings the author (`by`) accepted in this change.' },
}
const revisionSummarySchema = { type: 'object', properties: revisionFields }
const revisionPageFields = {
  revisions: { type: 'array', items: revisionSummarySchema, description: 'Newest first, without the document.' },
  total: { type: 'integer' },
  page: { type: 'integer' },
  pageSize: { type: 'integer' },
}
const diffSideSchema = {
  type: 'object',
  properties: {
    revision: { oneOf: [{ type: 'integer' }, { type: 'string', enum: ['current'] }], description: '`0` = before the item existed.' },
    exists: { type: 'boolean' },
    hash: { type: 'string' },
    op: { type: 'string' },
    at: { type: 'string', format: 'date-time' },
    by: { type: 'string' },
  },
}
const wideningSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Stable: `<kind>/<id>[@<project>]#<field><op><value>`, e.g. `agent/theo#allowedTools+cap:terminal`.' },
    description: { type: 'string' },
  },
}
const restoreFailures = {
  '403': {
    description:
      'Code `forbidden`: the change widens access and the request came with an access token (CI). Only an administrator signed in on the screen accepts a widening, even with `confirm`. `details.widenings` lists them.',
    content: { 'application/json': { schema: failureEnvelope } },
  },
  '409': {
    description:
      'Code `revision_conflict`: the item changed after `expectedRevision` (or outside the history); `details.current` has the current revision — review the diff and try again. Code `widening_confirmation_required`: the change widens access and `confirm` is not EXACTLY the set of keys in `details.widenings` (missing, extra or fewer).',
    content: { 'application/json': { schema: failureEnvelope } },
  },
  '422': {
    description: "Invalid body, or the version does not pass today's rules (a disabled model, a document that no longer exists…): `details` lists the problems.",
    content: { 'application/json': { schema: failureEnvelope } },
  },
}
const diffLineSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['equal', 'add', 'remove'] },
    text: { type: 'string' },
    oldLine: { type: 'integer', description: 'Absent on an added line.' },
    newLine: { type: 'integer', description: 'Absent on a removed line.' },
    noNewline: { type: 'boolean', description: 'The last line of the text, without a trailing newline.' },
  },
}

const importItemStates = ['pending', 'drafting', 'review', 'approved', 'rejected', 'skipped', 'applied', 'error', 'stale']
const importItemStatus = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    state: { type: 'string', enum: importItemStates },
    staleFrom: { type: 'string', enum: importItemStates, description: '`stale`: the state before the sources changed' },
    kind: { type: 'string', description: 'The kind chosen by a person (absent = the detected kind)' },
    fingerprint: { type: 'string', description: 'sha256 of the sources (path + sha256) in this job' },
    targetId: { type: 'string' },
    conversationId: { type: 'string' },
    conversationLost: { type: 'boolean', description: '`drafting` whose builder conversation no longer exists: open the builder again for it' },
    drafts: { type: 'array', items: {} },
    review: {},
    approvedBy: { type: 'string' },
    approvedAt: { type: 'string', format: 'date-time' },
    batchId: { type: 'string' },
    by: { type: 'string', description: 'Who changed the item last (state or kind)' },
    at: { type: 'string', format: 'date-time' },
    goneAt: {
      type: 'string',
      format: 'date-time',
      description:
        'The item LEFT THE SOURCE (the analysis when it stopped appearing). Not a state: it keeps its state, never goes to the builder nor to the write; cleared if it comes back',
    },
  },
}
const stringList = { type: 'array', items: { type: 'string' } }
const importAnalysis = {
  type: 'object',
  description: 'One analysis of the import: when, who, the HEAD and what changed in the items',
  properties: {
    at: { type: 'string', format: 'date-time' },
    by: { type: 'string' },
    head: { type: 'string' },
    dirty: { type: 'boolean' },
    kept: { type: 'integer', description: 'Same sources (or nothing decided): the item stayed as it was' },
    stale: { ...stringList, description: 'Sources changed after the decision: became `stale`' },
    added: { ...stringList, description: 'New in the source: `pending`' },
    gone: { ...stringList, description: 'Left the source in this analysis' },
    restored: { ...stringList, description: 'Was `stale` and the sources went back to those of the decision' },
    returned: { ...stringList, description: 'Had left the source and came back' },
  },
}
const importJobFields = {
  id: { type: 'string' },
  projectId: { type: 'string' },
  repository: { type: 'string' },
  head: { type: 'string' },
  dirty: { type: 'boolean' },
  scannedAt: { type: 'string', format: 'date-time' },
  by: { type: 'string', description: 'Who ran the last analysis' },
  items: { type: 'integer' },
  byState: { type: 'object', additionalProperties: { type: 'integer' } },
  gone: { type: 'integer', description: 'Items that left the source' },
  latest: { type: 'boolean', description: 'Always true: there is one import per repository (kept for older clients)' },
  analyses: { type: 'array', items: importAnalysis, description: 'The last analyses, newest first (at most 20)' },
}
const importJobSummary = { type: 'object', properties: importJobFields }
const importJob = {
  type: 'object',
  properties: {
    ...importJobFields,
    scan: { type: 'object', additionalProperties: true, description: 'The saved inventory, as `POST /projects/{id}/import/scan` returns it' },
    states: { type: 'array', items: importItemStatus },
  },
}
const selectionPlan = {
  type: 'object',
  properties: {
    keys: { type: 'array', items: { type: 'string' } },
    prefix: { type: 'string' },
    phases: { type: 'array', items: { type: 'object', additionalProperties: true } },
    steps: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description: 'In order; `done` (`catalog` | `approved`) marks a step with no builder conversation',
    },
    idMap: { type: 'array', items: { type: 'object', additionalProperties: true } },
    cycles: { type: 'array', items: { type: 'object', additionalProperties: true } },
    outside: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description: 'Citations to items outside the selection, with `state`: catalog | approved | batch | missing | broken | not-importable',
    },
    excluded: { type: 'array', items: { type: 'object', additionalProperties: true } },
    estimate: { type: 'object', additionalProperties: true },
    blocked: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
}
const importBatchFields = {
  id: { type: 'string' },
  jobId: { type: 'string' },
  name: { type: 'string' },
  prefix: { type: 'string' },
  keys: { type: 'array', items: { type: 'string' } },
  order: { type: 'array', items: { type: 'string' }, description: 'The order computed when the batch was saved' },
  by: { type: 'string' },
  at: { type: 'string', format: 'date-time' },
  gone: { ...stringList, description: 'Keys of the batch whose item left the source: kept in the batch, out of the order' },
}
const importBatch = { type: 'object', properties: { ...importBatchFields, plan: selectionPlan } }
const importBatchRun = {
  type: 'object',
  properties: {
    conversationId: { type: 'string' },
    kind: { type: 'string' },
    agentId: { type: 'string' },
    keys: { type: 'array', items: { type: 'string' } },
    pending: { type: 'array', items: { type: 'string' } },
    run: { type: 'object', properties: { state: { type: 'string', enum: ['queued', 'running', 'ok', 'error', 'aborted'] }, error: { type: 'string' }, at: { type: 'string' } } },
  },
}
const selectionBody = {
  keys: { type: 'array', items: { type: 'string' }, description: 'The keys of the selected items of the job' },
  prefix: { type: 'string', description: 'Optional id prefix (lowercase letters, digits and "-", up to 16)' },
  closure: {
    type: 'boolean',
    description: 'With the DEPENDENCIES: each key brings its closure (an agent with its triggers, a trigger with its agent, and what they cite, transitively)',
  },
}
/** A seleção da gravação do importador. */
const importApplySelection = {
  type: 'object',
  properties: {
    batchId: { type: 'string', description: 'A saved batch: its approved items.' },
    keys: { type: 'array', items: { type: 'string' }, description: 'Or these items (the approved among them). Neither: every approved item of the job.' },
    wide: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
      description: 'Per agent key: the WIDE translated rules the person includes (none by default).',
    },
    models: {
      type: 'object',
      additionalProperties: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } },
      description: 'Per agent key: the model it will use.',
    },
    ready: {
      type: 'boolean',
      description:
        'Only the READY items: an item with a blocked document (error or conflict in the plan) stays out; the preview lists them in `heldBack` with the reason. What only CITES a left-out document is not held back: it is written without that link, with a `link-pending` import issue (see `importIssues`).',
    },
  },
}
const jobParams = [
  { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
  { name: 'job', in: 'path', required: true, schema: { type: 'string' } },
]
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

// O ledger dos agentes (a guia Memória). Os nomes são os do domínio; o `ledger_write` do agente traduz para cá.
const ledgerAuthorSchema = {
  type: 'object',
  description: 'Who changed it: the agent itself (in a conversation) or an administrator on the screen.',
  properties: { kind: { type: 'string', enum: ['agent', 'admin'] }, agentId: { type: 'string' }, conversationId: { type: 'string' }, email: { type: 'string' } },
}
const ledgerWarningSchema = {
  type: 'object',
  description: 'A health warning, computed on read (never stored). Without `topic` it is about the whole ledger.',
  properties: {
    code: { type: 'string', enum: ['trigger-missing', 'trigger-weak', 'state-verb', 'too-many-lines', 'similar-topics', 'empty-context'] },
    topic: { type: 'string' },
    related: { type: 'string', description: '`similar-topics`: the other theme.' },
    lineId: { type: 'integer' },
    message: { type: 'string' },
  },
}
const ledgerLineTypes = { type: 'string', enum: ['APRENDIZADO', 'POSTURA', 'DIFICULDADE'], description: 'REGRA, MODO and FALHA are accepted as aliases on write.' }
const ledgerLineSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    date: { type: 'string', description: 'YYYY-MM-DD: when it was learned.' },
    type: ledgerLineTypes,
    trigger: { type: 'string', description: 'When it applies (one line).' },
    learning: { type: 'string', description: 'The learning, one sentence (≤ 300 characters).' },
    ref: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    createdBy: ledgerAuthorSchema,
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: ledgerAuthorSchema,
  },
}
const ledgerSummaryFields = {
  topic: { type: 'string', description: 'The theme slug, unique in the agent ledger.' },
  trigger: { type: 'string', description: 'WHEN to load it (one line, ≥ 15 characters).' },
  lineCount: { type: 'integer' },
  hasPlaybook: { type: 'boolean' },
  createdAt: { type: 'string', format: 'date-time' },
  createdBy: ledgerAuthorSchema,
  updatedAt: { type: 'string', format: 'date-time' },
  updatedBy: ledgerAuthorSchema,
  warnings: { type: 'array', items: ledgerWarningSchema },
}
const ledgerContextSchema = {
  type: 'object',
  properties: { ...ledgerSummaryFields, playbook: { type: 'string', description: 'Markdown appendix; empty = none.' }, lines: { type: 'array', items: ledgerLineSchema } },
}
const ledgerIndexSchema = {
  type: 'object',
  properties: {
    agentId: { type: 'string' },
    contexts: { type: 'array', items: { type: 'object', properties: ledgerSummaryFields } },
    lineCount: { type: 'integer' },
    warnings: { type: 'array', items: ledgerWarningSchema },
  },
}
const ledgerWriteSchema = {
  type: 'object',
  description: 'The change applied: the context after it (absent after a delete) and the whole index, so the screen updates without re-reading.',
  properties: {
    action: { type: 'string', enum: ['criar', 'gatilho', 'playbook', 'linha_nova', 'linha_editar', 'linha_apagar', 'excluir'] },
    topic: { type: 'string' },
    context: ledgerContextSchema,
    index: ledgerIndexSchema,
    warnings: { type: 'array', items: ledgerWarningSchema },
    changed: { type: 'boolean', description: 'false = nothing changed (same text): no revision.' },
  },
}
const ledgerSnapshotSchema = { type: 'object', description: 'A context ({ trigger, playbook, lines? }) or a line ({ id, date, type, trigger, learning, ref }).' }
const ledgerRevisionSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    agentId: { type: 'string' },
    topic: { type: 'string' },
    action: ledgerWriteSchema.properties.action,
    lineId: { type: 'integer' },
    at: { type: 'string', format: 'date-time' },
    by: ledgerAuthorSchema,
    before: ledgerSnapshotSchema,
    after: ledgerSnapshotSchema,
  },
}
const ledgerParams = [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }]
const ledgerTopicParams = [...ledgerParams, { name: 'topic', in: 'path', required: true, schema: { type: 'string' } }]
const ledgerLineParams = [...ledgerTopicParams, { name: 'lineId', in: 'path', required: true, schema: { type: 'integer' } }]
const ledgerLineBody = {
  type: 'object',
  properties: {
    type: ledgerLineTypes,
    trigger: { type: 'string' },
    learning: { type: 'string' },
    ref: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD; default today.' },
  },
}
const ledgerWriteResponses = (status: '200' | '201') => ({
  [status]: { description: 'OK', ...json(envelope(ledgerWriteSchema)) },
  '404': failures['404'],
  '422': failures['422'],
})

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
const DOC_IDS_DESCRIPTION =
  'Other documents attached to this one, in order (global ones, or of the same project; a global document attaches only global ones). They go along when this one is read: in full, unless listed in docRefs.'
const DOC_REFS_DESCRIPTION = 'Which of docIds go by reference: listed with id, title and size, and the agent reads them with read_doc if needed.'
const docSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Slug; what agents pass to read_doc.' },
    kind: { type: 'string', enum: ['spec', 'adr', 'knowledge'] },
    projectId: { type: 'string', description: 'Absent = global.' },
    title: { type: 'string' },
    summary: { type: 'string', description: 'One line: what the conversation index shows.' },
    body: { type: 'string', description: 'Markdown. Absent in the list.' },
    docIds: { type: 'array', items: { type: 'string' }, description: DOC_IDS_DESCRIPTION },
    docRefs: { type: 'array', items: { type: 'string' }, description: DOC_REFS_DESCRIPTION },
    loadedIn: {
      type: 'object',
      description: 'List only: who loads this spec in full (their initial context).',
      properties: { projects: { type: 'array', items: { type: 'string' } }, agents: { type: 'array', items: { type: 'string' } } },
    },
    tokens: { type: 'integer', description: 'List only: estimated tokens of the body (≈ 4 characters per token).' },
    importIssues: importIssuesSchema,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
  },
}
const docBody = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Only on create.' },
    kind: { type: 'string', enum: ['spec', 'adr', 'knowledge'] },
    projectId: { type: 'string', nullable: true, description: 'The project; null = global.' },
    title: { type: 'string' },
    summary: { type: 'string' },
    body: { type: 'string' },
    docIds: { type: 'array', items: { type: 'string' }, description: `${DOC_IDS_DESCRIPTION} Absent on update = keep.` },
    docRefs: { type: 'array', items: { type: 'string' }, description: `${DOC_REFS_DESCRIPTION} Absent on update = keep.` },
  },
}
const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
/** A lista de arquivos de um recurso ou agente: o conteúdo mora no depósito por sha256 (POST /files). */
const resourceFiles = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative to the resource folder, with "/" (scripts/run.mjs)' },
      sha256: { type: 'string' },
      bytes: { type: 'integer' },
    },
    required: ['path', 'sha256', 'bytes'],
  },
}
const resourceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Slug: the skill name in the index, the /name of a command.' },
    kind: { type: 'string', enum: ['skill', 'command'] },
    projectId: { type: 'string', description: 'Absent = global.' },
    description: { type: 'string', description: 'One line: what the agent (and the autocomplete) reads to know when to use it.' },
    body: { type: 'string', description: 'Skill: markdown. Command: the request sent to the agent; $ARGUMENTS takes what follows /name.' },
    docIds: { type: 'array', items: { type: 'string' }, description: 'Specs/ADRs attached, in order. They go along in full, unless listed in docRefs.' },
    docRefs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Which of docIds go by reference: the loaded resource lists id, title and size, and the agent reads them with read_doc if needed. Absent on update = keep.',
    },
    files: { ...resourceFiles, description: 'The files of the resource folder (content uploaded with POST /files). Absent on update = keep.' },
    triggers: {
      type: 'array',
      description:
        'The procedures of one situation inside this skill or command, like the triggers of an agent: the loaded resource lists only id and when; the agent loads one with use_resource (kind trigger, id <resource>/<trigger>). Absent on update = keep; [] removes all.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Slug, unique in the resource.' },
          when: { type: 'string', description: 'One line: the situation that fires it.' },
          body: { type: 'string' },
        },
        required: ['id', 'when', 'body'],
      },
    },
    importIssues: { ...importIssuesSchema, readOnly: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
  },
}
const agentResources = {
  type: 'object',
  properties: { skills: { type: 'array', items: { type: 'string' } }, commands: { type: 'array', items: { type: 'string' } } },
  description: 'Ids, or ["*"] = every global one plus those of the agent project (a global agent: only global ones) — the default when nothing was set; [] = none on purpose.',
}
const scheduleRunSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    trigger: { type: 'string', enum: ['cron', 'manual'] },
    scheduledFor: { type: 'string', format: 'date-time' },
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['running', 'ok', 'error', 'skipped', 'missed'] },
    sessionId: { type: 'string' },
    error: { type: 'string' },
  },
}
const scheduleInput = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Slug (create only).' },
    cron: { type: 'string', description: '5 fields: minute hour day month weekday ("0 8 * * 1-5").' },
    timezone: { type: 'string', description: 'IANA; default America/Sao_Paulo.' },
    prompt: { type: 'string', description: 'What the agent gets, as typed in the chat (/command args works).' },
    session: { type: 'string', enum: ['new', 'continuous'] },
    projectId: { type: 'string', nullable: true, description: 'For a global agent: the project its conversation runs in.' },
    enabled: { type: 'boolean' },
  },
}
const projectAccountSchema = {
  type: 'object',
  properties: {
    projectId: { type: 'string' },
    id: { type: 'string' },
    kind: { type: 'string', enum: ['github-app', 'github-token', 'git-https', 'gcp-service-account', 'ssh-ca', 'ssh-key', 'secret-env', 'turn-callback'] },
    label: { type: 'string' },
    public: {
      type: 'object',
      additionalProperties: true,
      description: 'What may be shown: owner, git base URL and username, app and installation ids, repositories, variable name, last 4 chars of the secret',
    },
    exposesSecret: { type: 'boolean', description: 'The command receives the secret itself (not a short-lived derivative)' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
  },
}

const permissionRuleSchema = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['terminal', 'read', 'write', 'network', 'mcp', 'skill', 'delegate', 'account', 'repository', 'trigger'] },
    pattern: {
      type: 'string',
      description:
        'terminal: words (`git push *`); read/write: glob on the canonical path (`apps/**`, `*.env`); network: host[:port] (`*.x.com`); mcp: `server/tool`; skill/delegate: id glob',
    },
    decision: { type: 'string', enum: ['allow', 'deny'] },
    note: { type: 'string' },
  },
  required: ['category', 'pattern', 'decision'],
}
/** Um pedido de permissão do agente (ver `PermissionRequests.Service`). */
const permissionRequestSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['agent-rules', 'project-rules', 'agent-patch'], description: 'What changes: an agent rules, a project rules, or agent fields.' },
    agentId: { type: 'string' },
    agentName: { type: 'string' },
    projectId: { type: 'string' },
    projectName: { type: 'string' },
    patch: { type: 'object', description: '`agent-patch`: the requested field values (null = remove).' },
    add: { type: 'array', items: permissionRuleSchema },
    remove: { type: 'array', items: permissionRuleSchema },
    widenings: { type: 'array', items: wideningSchema, description: 'What approving would widen NOW (on the current agent): the keys `confirm` must carry.' },
    requestedWidenings: { type: 'array', items: wideningSchema, description: 'As computed when the agent asked.' },
    changed: { type: 'boolean', description: 'The agent rules changed since the request: `widenings` was recomputed.' },
    reason: { type: 'string' },
    requestedBy: {
      type: 'object',
      properties: { by: { type: 'string' }, agentId: { type: 'string' }, conversationId: { type: 'string' } },
      description: '`by` is the account; `agentId` and `conversationId` are labels from the identity headers.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired'] },
    decidedBy: { type: 'string' },
    decidedAt: { type: 'string', format: 'date-time' },
    decisionNote: { type: 'string' },
  },
}

const scheduleSchema = {
  type: 'object',
  properties: {
    ...scheduleInput.properties,
    agentId: { type: 'string' },
    sessionId: { type: 'string' },
    runAs: { type: 'string' },
    failures: { type: 'integer' },
    pausedReason: { type: 'string' },
    nextRunAt: { type: 'string', format: 'date-time' },
    lastRun: scheduleRunSchema,
  },
}
const agentIdParam = { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }
const scheduleNameParam = { name: 'scheduleName', in: 'path', required: true, schema: { type: 'string' } }
const protocolAddendum = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    projectId: { type: 'string' },
    body: { type: 'string' },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string' },
  },
}
const protocolView = {
  type: 'object',
  properties: {
    core: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill', 'command'] },
        version: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown.' },
      },
    },
    addenda: { type: 'object', properties: { global: protocolAddendum, project: protocolAddendum } },
  },
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
    period: {
      type: 'object',
      properties: {
        days: { oneOf: [{ type: 'integer' }, { type: 'string', enum: ['all'] }], description: '`all` = the whole history (only by metadata key, without `days`).' },
        since: { type: 'string', format: 'date-time' },
        tzOffsetMinutes: { type: 'integer' },
      },
    },
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
    byTool: {
      type: 'array',
      description:
        'ESTIMATE per tool (providers bill per model call, never per tool): `directTokens` = arguments + result once; `contextTokens` = the result re-read by the later steps of its turn, capped at the input the provider reported for the turn. The 100 heaviest.',
      items: {
        type: 'object',
        properties: { tool: { type: 'string' }, calls: { type: 'integer' }, errors: { type: 'integer' }, directTokens: { type: 'integer' }, contextTokens: { type: 'integer' } },
      },
    },
  },
})
const usageParams = [
  { name: 'days', in: 'query', schema: { type: 'integer', enum: [7, 30, 90], default: 30 }, description: 'Period, counting today.' },
  { name: 'project', in: 'query', schema: { type: 'string' }, description: 'Only the conversations of this project (absent = all).' },
  { name: 'tz', in: 'query', schema: { type: 'integer' }, description: 'Minutes to add to UTC for local time (São Paulo: -180). Days are cut in this time zone.' },
]
/** Por chave do `metadata`: sem `days`, o histórico inteiro (o custo de um épico é o do épico todo). */
const usageByKeyParams = [
  {
    name: 'days',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 400 },
    description: 'Period, counting today. Absent = the whole history (`period.days: "all"`, `period.since` = the first day with usage). Out of range = 422.',
  },
  ...usageParams.slice(1),
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
        parameters: [{ name: 'project', in: 'query', required: false, schema: { type: 'string' } }],
        summary:
          'The MCP servers agents can use tools from: URL, transport, authentication (caller credential, a fixed secret header, or none), status and the agents using each. The secret is never returned. Administrators (all; with ?project, the global ones and that project ones); a project member only with ?project=<own project>, and only that project servers',
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
    '/projects/{id}/repositories': {
      get: {
        summary: 'The repositories of a project (`repositories/<name>`, git only) and the worktrees of each one inside the project. For whoever can use the project',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    worktrees: {
                      type: 'array',
                      items: { type: 'object', properties: { name: { type: 'string' }, branch: { type: 'string' }, path: { type: 'string' } } },
                    },
                  },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
    },
    '/projects/{id}/import/scan': {
      post: {
        summary:
          'Inventory of the agentic resources a repository of the project already has (`.agents/`, opencode, `.claude/` and `CLAUDE.md`, `AGENTS.md`): probable kind, sources with size, ≈tokens and sha256, cross references (found or broken), generated and secret marks, and whether the id already exists in the catalog. READ ONLY: nothing is saved and no content is returned. Administrators only (404 for the others)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              repository: { type: 'string', description: 'The folder name in `<project>/repositories/`' },
              ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns ignored in this scan only, added to the project ones' },
            },
            required: ['repository'],
          }),
        },
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  projectId: { type: 'string' },
                  repository: { type: 'string' },
                  head: { type: 'string' },
                  dirty: { type: 'boolean' },
                  scannedAt: { type: 'string', format: 'date-time' },
                  formats: { type: 'array', items: { type: 'string' } },
                  totals: { type: 'object', additionalProperties: true },
                  ignored: {
                    type: 'object',
                    properties: {
                      dirs: { type: 'object', additionalProperties: { type: 'integer' } },
                      binaries: { type: 'array', items: { type: 'string' } },
                      links: {
                        type: 'array',
                        items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string', enum: ['outside', 'cycle', 'broken'] } } },
                      },
                      patterns: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: { pattern: { type: 'string' }, origin: { type: 'string', enum: ['project', 'request'] }, files: { type: 'integer' } },
                        },
                      },
                    },
                  },
                  scope: {
                    type: 'object',
                    description:
                      'The agentic environment looked at: each default place (on/off, found in the repository, files), the extra paths and how many files were left outside',
                    properties: {
                      places: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: { place: { type: 'string' }, enabled: { type: 'boolean' }, found: { type: 'boolean' }, files: { type: 'integer' } },
                        },
                      },
                      extra: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, files: { type: 'integer' } } } },
                      outside: { type: 'integer' },
                    },
                  },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        key: { type: 'string' },
                        kind: { type: 'string', enum: ['skill', 'command', 'rule', 'spec', 'adr', 'knowledge', 'agent', 'trigger', 'mcp', 'config', 'unknown', 'skip'] },
                        parent: { type: 'string' },
                        candidateId: { type: 'string' },
                        title: { type: 'string' },
                        detectors: { type: 'array', items: { type: 'string' } },
                        sources: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              path: { type: 'string' },
                              aliases: { type: 'array', items: { type: 'string' } },
                              bytes: { type: 'integer' },
                              tokens: { type: 'integer' },
                              sha256: { type: 'string' },
                              role: { type: 'string' },
                              generated: { type: 'array', items: { type: 'string' } },
                              secret: { type: 'boolean' },
                            },
                          },
                        },
                        refs: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, item: { type: 'string' } } } },
                        unresolved: { type: 'array', items: { type: 'string' } },
                        catalog: { type: 'string', enum: ['new', 'same-project', 'global', 'other-project'] },
                        notes: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: { level: { type: 'string', enum: ['info', 'attention', 'untranslatable'] }, code: { type: 'string' }, text: { type: 'string' } },
                          },
                        },
                      },
                    },
                  },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/plan': {
      post: {
        summary:
          'The import BATCH of one agent of the inventory: the closure (its triggers and what they cite, transitively), the order by phase (docs → skills/commands → rules → closed agent with triggers → links → reach → project permissions) with cycles, the id map (optional prefix, collisions block), the reach translated by the deterministic translator (rules, widenings, allowedTools, proposed resources.skills), what stays out and the cost estimate (builder conversations and input tokens). READ ONLY: nothing is saved and no builder runs. Administrators only (404 for the others)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              repository: { type: 'string', description: 'The folder name in `<project>/repositories/`' },
              agent: { type: 'string', description: 'The agent of the inventory: its key (`agent:<id>`) or its candidate id' },
              prefix: { type: 'string', description: 'Optional id prefix (lowercase letters, digits and "-", up to 16), for agent, skill, command and doc ids' },
              ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns ignored in this scan only, added to the project ones' },
              job: { type: 'string', description: 'The open import job of the same repository: its approved and applied items are marked done' },
            },
            required: ['repository', 'agent'],
          }),
        },
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  projectId: { type: 'string' },
                  repository: { type: 'string' },
                  head: { type: 'string' },
                  dirty: { type: 'boolean' },
                  plannedAt: { type: 'string', format: 'date-time' },
                  agent: { type: 'string' },
                  prefix: { type: 'string' },
                  phases: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  links: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  reach: { type: 'object', additionalProperties: true },
                  project: { type: 'object', additionalProperties: true },
                  idMap: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  excluded: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  released: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  mcps: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  cycles: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  estimate: { type: 'object', additionalProperties: true },
                  blocked: { type: 'array', items: { type: 'string' } },
                  notes: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              }),
            ),
          },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/ignore': {
      get: {
        summary:
          'The glob patterns the import scan ignores in the repositories of this project (gitignore-like: no `/` matches the name in any folder; with `/`, from the repository root). Administrators only (404 for the others)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { patterns: { type: 'array', items: { type: 'string' } } } })) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
      put: {
        summary: 'Replace the ignore patterns of the import scan for this project (an empty list clears them). Absolute patterns and `..` are refused. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json({ type: 'object', properties: { patterns: { type: 'array', items: { type: 'string' } } }, required: ['patterns'] }) },
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { patterns: { type: 'array', items: { type: 'string' } } } })) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/scope': {
      get: {
        summary:
          'The AGENTIC ENVIRONMENT the import scan looks at in the repositories of this project: an include list (the known places of each tool — `.agents/`, `.claude/`, `CLAUDE.md`, `.opencode/`, `AGENTS.md`, `.cursor/`… — and only the entry files in subfolders), which defaults are off and the extra paths. Files outside it never enter the inventory; citations to them are references only. The ignore patterns still apply inside it. Administrators only (404 for the others)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  tools: {
                    type: 'array',
                    description: 'The default places, by tool (read-only; a place ending in `/` is a folder; `**/NAME` is only the entry file in subfolders)',
                    items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, places: { type: 'array', items: { type: 'string' } } } },
                  },
                  disabled: { type: 'array', items: { type: 'string' }, description: 'Default places turned OFF (every other default is on)' },
                  extra: { type: 'array', items: { type: 'string' }, description: 'Extra paths/globs included (gitignore-like, relative to the repository root)' },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
      put: {
        summary:
          'Replace the agentic environment of the import scan for this project: the default places turned off and the extra paths (absolute paths, `..` and unknown places are refused). Applies on the next analysis. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: { disabled: { type: 'array', items: { type: 'string' } }, extra: { type: 'array', items: { type: 'string' } } },
            required: ['disabled', 'extra'],
          }),
        },
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  tools: {
                    type: 'array',
                    description: 'The default places, by tool (read-only; a place ending in `/` is a folder; `**/NAME` is only the entry file in subfolders)',
                    items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, places: { type: 'array', items: { type: 'string' } } } },
                  },
                  disabled: { type: 'array', items: { type: 'string' }, description: 'Default places turned OFF (every other default is on)' },
                  extra: { type: 'array', items: { type: 'string' }, description: 'Extra paths/globs included (gitignore-like, relative to the repository root)' },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/imported': {
      post: {
        summary:
          'An agent saved in the catalog, OUTSIDE the importer, what came from this source (the `save_*` MCP tools with `importedFrom`): the import item of the project with that source (the file, or its folder) becomes `applied`, with `importedBy` (the catalog kind and id, and the agent and conversation from the identity headers). It leaves the queue. A record, not a decision: nothing is approved or written to the catalog here. 422 when no item has the source, the kind does not match, or the source is in more than one repository without `repository`; 409 while the builder holds the item. Administrators only (404 for the others)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['path', 'kind', 'id'],
                properties: {
                  path: { type: 'string', description: 'The source path in the repository, as the importer lists it.' },
                  repository: { type: 'string', description: 'The repository, when the path is in more than one import.' },
                  kind: { type: 'string', description: 'The catalog kind of what was saved (skill, command, spec, adr, knowledge, rule, agent).' },
                  id: { type: 'string', description: 'The catalog id of what was saved.' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'The import item, now applied, with its repository and job id' } },
      },
    },
    '/projects/{id}/import/jobs': {
      get: {
        summary:
          'The IMPORTS of the project, ONE per repository, the most recently analyzed first: the saved inventory of the last analysis (HEAD, date, who), how many items are in each state, how many left the source, and the last analyses (`analyses`). Administrators only (404 for the others)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'array', items: importJobSummary })) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
      post: {
        summary:
          'ANALYZE a repository of the project: the first time it creates its import (every item `pending`); afterwards it updates the SAME import in place (same id): inventory, HEAD and date. Each item, by key: same sources stay as they are (draft, approval, conversation, batch); sources changed since the last decision become `stale` (with `staleFrom`); new items enter `pending`; items that left the source are kept and flagged (`goneAt`), and the flag clears if they come back. Saved batches stay. Returns the import and `analysis` (what changed in this run; also logged in `analyses`). Nothing is written to the catalog and no builder runs. Administrators only (404 for the others; a repository of another project is 422)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              repository: { type: 'string', description: 'The folder name in `<project>/repositories/`' },
              ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns ignored in this scan only, added to the project ones' },
            },
            required: ['repository'],
          }),
        },
        responses: {
          '200': { description: 'OK', ...json(envelope({ ...importJob, properties: { ...importJob.properties, analysis: importAnalysis } })) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}': {
      get: {
        summary: 'One import job: the saved inventory (as the scan returns it) and the state of each item. A job of another project does not exist here (404). Administrators only',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'job', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK', ...json(envelope(importJob)) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/items': {
      get: {
        summary:
          'The state of SOME items of an import job (the draft, the review), without the inventory: the panel beside an import conversation reloads it after each proposal. A key that is not in the job is left out. `latest`: always true (one import per repository). Administrators only',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'job', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'keys', in: 'query', required: true, style: 'form', explode: true, schema: { type: 'array', items: { type: 'string' }, maxItems: 200 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(envelope({ type: 'object', properties: { latest: { type: 'boolean' }, states: { type: 'array', items: importItemStatus } }, required: ['latest', 'states'] })),
          },
          '422': failures['422'],
          '401': failures['401'],
          '404': failures['404'],
        },
      },
      patch: {
        summary:
          'Change one item of the NEWEST job of its repository: exclude (`state: skipped`), include (`state: pending`) and reclassify (`kind`; `null` goes back to the detected kind). Records who and when. An older job is 409; a transition the state does not allow, or reclassifying an item with a draft on the way, is 409. An item with the builder and no draft yet leaves the conversation and goes back to `pending`. Nothing is written to the catalog. Administrators only',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'job', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              key: { type: 'string', description: 'The item key (`<kind>:<id>`, `trigger:<agent>/<id>`)' },
              state: { type: 'string', enum: ['pending', 'skipped'] },
              kind: { type: 'string', nullable: true, enum: ['skill', 'command', 'rule', 'spec', 'adr', 'knowledge', 'agent', 'trigger', 'mcp', 'config', 'unknown', 'skip'] },
            },
            required: ['key'],
          }),
        },
        responses: {
          '200': { description: 'OK', ...json(envelope(importItemStatus)) },
          '401': failures['401'],
          '404': failures['404'],
          '409': {
            description: 'Code `import_state_conflict`: the state does not allow the change',
            content: { 'application/json': { schema: failureEnvelope } },
          },
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/batches/plan': {
      post: {
        summary:
          'The BATCH OF A SELECTION of items of an import job, not saved: the order only among the selected items (by phase, cited before who cites), the cycles, the id map (optional prefix), the citations to items outside the selection (in the catalog, approved, in another batch, missing, broken) and the estimate. Items already in the catalog or approved are marked done and do not count. READ ONLY. Administrators only (404 for the others; a job of another project is 404)',
        parameters: jobParams,
        requestBody: { required: true, ...json({ type: 'object', properties: selectionBody, required: ['keys'] }) },
        responses: {
          '200': { description: 'OK', ...json(envelope(selectionPlan)) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/batches': {
      get: {
        summary: 'The batches saved in an import job, newest first. Administrators only (404 for the others; a job of another project is 404)',
        parameters: jobParams,
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'array', items: { type: 'object', properties: importBatchFields } })) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
      post: {
        summary:
          'SAVE the batch of a selection in the NEWEST job of its repository: name, items, order, who and when. Nothing runs and nothing is written to the catalog. An older job is 409. Administrators only (404 for the others)',
        parameters: jobParams,
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { name: { type: 'string', maxLength: 120 }, ...selectionBody }, required: ['name', 'keys'] }),
        },
        responses: {
          '200': { description: 'OK', ...json(envelope(importBatch)) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/batches/{batch}': {
      get: {
        summary: 'One saved batch, with the batch computed again over the current state (approved, applied, other batches). Administrators only',
        parameters: [...jobParams, { name: 'batch', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK', ...json(envelope(importBatch)) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/batches/{batch}/items': {
      post: {
        summary:
          'ADD items to a saved batch (with their dependencies when `closure`): the order is computed again over all of them. Keys whose item left the source stay in the batch (`gone`). Nothing is written to the catalog. Administrators only',
        parameters: [...jobParams, { name: 'batch', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json({ type: 'object', properties: selectionBody, required: ['keys'] }) },
        responses: {
          '200': { description: 'The batch, with the batch computed again', ...json(envelope(importBatch)) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/batches/{batch}/prepare': {
      post: {
        summary:
          'PREPARE ALL: the saved batch goes to the builder at once, ONE conversation per builder (the agent with its triggers, the specs, the skills…), with the items that still go (no conversation or draft in progress). With `start`, every batch conversation that still owes a draft runs a turn ON THE SERVER (no open tab), `concurrency` at a time (default 3, at most 5). Returns the opened conversations and the batch conversations with their progress (`runs`). Nothing is approved or written to the catalog. Administrators only',
        parameters: [...jobParams, { name: 'batch', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: false,
          ...json({ type: 'object', properties: { start: { type: 'boolean' }, concurrency: { type: 'integer', minimum: 1, maximum: 5 } } }),
        },
        responses: {
          '200': {
            description: 'The opened conversations',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  conversations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { conversationId: { type: 'string' }, kind: { type: 'string' }, agentId: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } },
                    },
                  },
                  runs: { type: 'array', items: importBatchRun },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: 'An item cannot go to the builder now', ...json(failureEnvelope) },
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/batches/{batch}/conversations': {
      get: {
        summary:
          'The builder conversations of the saved batch: the items of each one, the ones it still owes (`pending`: drafting, with no draft or with an adjustment asked) and the progress of the server turn (`run`: queued, running, ok, error, aborted; absent when it never ran since the gateway started). Administrators only',
        parameters: [...jobParams, { name: 'batch', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'The batch conversations', ...json(envelope({ type: 'object', properties: { runs: { type: 'array', items: importBatchRun } } })) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/apply/plan': {
      post: {
        summary:
          'The PREVIEW of writing the importer to the catalog: the APPROVED items (of a saved batch, of `keys`, or all of the import; an item that left the source is skipped with the reason `saiu da fonte`) become canonical documents — each draft checked again against the source on disk (same sha256, same final text of source + operations; a changed source is 409 `import_source_changed`), the triggers inside their agent, the cited paths as links (`docIds`/`docRefs`/initial context). The agent is born CLOSED: the wide rules of the permission translator stay out unless included in `wide`; its reach (tools and rules) is a later step of the batch, and `resources.skills` is the skills it releases. Returns the catalog plan over those documents (diff, widenings, broken references, missing secrets, order, `planHash`), `missing` (each reference that exists neither in the catalog nor in the package, with the job item that produces it: key, kind, state, path), the agents (model, rules with `wide` and `included`), the active models, what was skipped and, with `ready`, `heldBack` (the items left out by a block, with the reason). IMPORT ISSUES do not block: a link to something that is not a document (an agent, a command, a memory file), that exists nowhere, belongs to another project or is a document of this job not written now is left out of the document and recorded in its `importIssues` (`items[].issues`, per `ref`); `resolved` lists the catalog artifacts whose pending link comes back because its target is written now (they go in the same batch). Every document goes to the project: an import is never global. Writes nothing. Administrators only',
        parameters: [...jobParams],
        requestBody: { required: false, ...json(importApplySelection) },
        responses: {
          '200': { description: 'The preview', ...json(envelope({ type: 'object' })) },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: '`import_source_changed` (a source changed on disk)', ...json(failureEnvelope) },
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/apply/fix': {
      post: {
        summary:
          'FIX WITH THE BUILDER: every approved item the preview of the write refuses for a problem of its OWN (not the ones only citing a refused item, nor the agent model, which is the person’s choice) goes back to its builder conversation (`drafting`) with the adjustment request written from the error, and that conversation runs a turn on the server, `concurrency` at a time (like "Preparar tudo"). Returns `reopened` (key and the problems sent), `skipped` (key and why) and `started` (the conversations queued). Writes nothing to the catalog: the new draft goes back to review. Administrators only',
        parameters: [...jobParams],
        requestBody: {
          required: false,
          ...json({ ...importApplySelection, properties: { ...importApplySelection.properties, concurrency: { type: 'integer', minimum: 1, maximum: 5 } } }),
        },
        responses: {
          '200': { description: 'What went back to the builder', ...json(envelope({ type: 'object' })) },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: '`import_source_changed`', ...json(failureEnvelope) },
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/apply': {
      post: {
        summary:
          'WRITES the approved items to the catalog: the same documents as the preview go through POST /catalog/import/apply — a different `planHash` is 409 with the new plan; every widening needs its key in `confirm` (exactly the set) and only an administrator signed in on the screen can accept one (403 for an access token); everything in ONE catalog batch, with provenance (job, repository, HEAD, sources and sha256). Items whose documents were all written become `applied` with the batch id; a batch stopped midway is `partial` (see `revert`). Administrators only',
        parameters: [...jobParams],
        requestBody: {
          required: true,
          ...json({
            ...importApplySelection,
            required: ['planHash'],
            properties: {
              ...importApplySelection.properties,
              planHash: { type: 'string' },
              confirm: { type: 'array', items: { type: 'string' }, description: 'The widening keys being accepted.' },
            },
          }),
        },
        responses: {
          '200': { description: 'Written (see `batch.status` and `items`)', ...json(envelope({ type: 'object' })) },
          '401': failures['401'],
          '403': restoreFailures['403'],
          '404': failures['404'],
          '409': {
            description: '`plan_changed` (`details.plan`), `widening_confirmation_required` (`details.widenings`) or `import_source_changed`',
            ...json(failureEnvelope),
          },
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/builder': {
      post: {
        summary:
          'Open ONE conversation with the builder of the kind, in import mode (no save tools), for a set of items of the import (never one that left the source), and link them to it (`drafting`). One builder per conversation (a trigger goes to the agent builder). The builder reads the sources through the server (contained, masked, sha256 checked) and proposes drafts as operations over the source; nothing is written to the catalog. Administrators only',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'job', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              keys: { type: 'array', items: { type: 'string' }, description: 'The item keys (1–200): the current selection' },
              batchId: { type: 'string', description: 'A saved batch: without keys, its items that still go to the builder' },
              kind: { type: 'string', enum: ['skill', 'command', 'rule', 'spec', 'adr', 'knowledge', 'agent'], description: 'Which builder, when the batch mixes kinds' },
            },
          }),
        },
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: { conversationId: { type: 'string' }, kind: { type: 'string' }, agentId: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '409': {
            description: 'Code `import_state_conflict` (an item cannot go to the builder, or left the source) or `builder_unavailable` (no builder model configured)',
            content: { 'application/json': { schema: failureEnvelope } },
          },
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/items/approve': {
      post: {
        summary:
          'Approve the draft of an item in `review`. Every removal operation needs its OK (`removals`: the operation indexes). The draft is checked again against the source on disk (same sha256, final text exactly source + operations). Only the state changes to `approved`: nothing is written to the catalog. Administrators only',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'job', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { key: { type: 'string' }, removals: { type: 'array', items: { type: 'integer' } } }, required: ['key'] }),
        },
        responses: {
          '200': { description: 'OK', ...json(envelope(importItemStatus)) },
          '401': failures['401'],
          '404': failures['404'],
          '409': {
            description: 'Code `import_state_conflict` (not in review) or `import_source_changed`',
            content: { 'application/json': { schema: failureEnvelope } },
          },
          '422': failures['422'],
        },
      },
    },
    '/projects/{id}/import/jobs/{job}/items/adjust': {
      post: {
        summary:
          'Ask for an adjustment: the item in `review` goes back to `drafting`, with the comment for the builder conversation (it reads it in list_import_items). Administrators only',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'job', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { key: { type: 'string' }, comment: { type: 'string' } }, required: ['key', 'comment'] }),
        },
        responses: {
          '200': { description: 'OK', ...json(envelope(importItemStatus)) },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: 'Code `import_state_conflict`', content: { 'application/json': { schema: failureEnvelope } } },
          '422': failures['422'],
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
    '/catalog/history': {
      get: {
        summary:
          'The catalog history (read only). With `kind` and `id`: the revisions of that item, newest first, plus its current state (`current.hash` different from the last revision = a change not recorded yet). Without them: the revisions of a scope, newest first — `project=<id>`, `project=global` or, absent, everything. Each revision is the whole canonical document (never a secret: MCP keeps only variable names). Administrators see everything; a project member only the MCP servers of their own projects (item or `project=<own project>`); anyone else gets 404',
        parameters: [
          { name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: catalogKinds }, description: 'With `id`: the item. See GET /catalog/history/diff.' },
          { name: 'id', in: 'query', required: false, schema: { type: 'string' }, description: 'With `kind`: the item (MCP: the server key).' },
          {
            name: 'project',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Without `kind`/`id`: the scope (a project id, or `global`). With them: completes the MCP or protocol key.',
          },
          ...historyPaging,
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: catalogKinds, description: 'Item form only.' },
                  itemId: { type: 'string', description: 'Item form only.' },
                  current: { type: 'object', description: 'Item form only.', properties: { exists: { type: 'boolean' }, hash: { type: 'string' } } },
                  scope: { type: 'string', description: 'Scope form only: `all`, `global` or `project:<id>`.' },
                  ...revisionPageFields,
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/catalog/history/revisions/{revision}': {
      get: {
        summary:
          'One revision of an item, with the whole canonical document (`document`, the JSON text that is compared and diffed; absent on `delete`). Same access as GET /catalog/history',
        parameters: [{ name: 'revision', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }, ...catalogItemParams],
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { ...revisionFields, document: { type: 'string' } } })) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/catalog/history/diff': {
      get: {
        summary:
          'Line diff of the canonical document of an item between two revisions, or between a revision and the current state. Defaults: `to=current`; `from` = the last revision (when `to` is current) or the one before `to` (what `to` changed). `0` = before the item existed. Returns the hunks with context and the same diff as unified text. Same access as GET /catalog/history',
        parameters: [
          ...catalogItemParams,
          {
            name: 'from',
            in: 'query',
            required: false,
            schema: {
              oneOf: [
                { type: 'integer', minimum: 0 },
                { type: 'string', enum: ['current'] },
              ],
            },
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            schema: {
              oneOf: [
                { type: 'integer', minimum: 0 },
                { type: 'string', enum: ['current'] },
              ],
            },
          },
          { name: 'context', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 50, default: 3 }, description: 'Lines of context around each change.' },
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: catalogKinds },
                  itemId: { type: 'string' },
                  from: diffSideSchema,
                  to: diffSideSchema,
                  equal: { type: 'boolean' },
                  added: { type: 'integer' },
                  removed: { type: 'integer' },
                  hunks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        oldStart: { type: 'integer' },
                        oldLines: { type: 'integer' },
                        newStart: { type: 'integer' },
                        newLines: { type: 'integer' },
                        lines: { type: 'array', items: diffLineSchema },
                      },
                    },
                  },
                  unified: { type: 'string', description: 'The unified diff (`---`, `+++`, `@@`); empty when equal.' },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/catalog/history/restore': {
      post: {
        summary:
          'Restores one revision of an item: writes a NEW revision (`op: restore`, note `restaurado da rev N`) with that content, through the same write path and validations as the screens; no revision is ever deleted. A deleted item comes back (its id must be free); restoring a `delete` revision deletes the item (never a project or its permissions). Optimistic concurrency: `expectedRevision` is the last revision the person saw. Access widenings (new tool, `allow` rule, MCP reach…) apply only when `confirm` is exactly the set the server computes, and only by an administrator signed in on the screen; the accepted keys are recorded in the revision. Secrets are not in the catalog: restoring an MCP never touches the vault, and `missingSecrets` says what to register. Administrators only (404 for the others)',
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['kind', 'id', 'revision', 'expectedRevision'],
            properties: {
              kind: { type: 'string', enum: catalogKinds },
              id: { type: 'string', description: 'As in GET /catalog/history (MCP: the server key; protocol addendum: `<project>/<kind>`).' },
              project: { type: 'string', description: 'Completes the MCP or protocol key, as in GET /catalog/history.' },
              revision: { type: 'integer', minimum: 1, description: 'The revision whose content comes back.' },
              expectedRevision: { type: 'integer', minimum: 0, description: 'The last revision the person saw (0 = none).' },
              confirm: { type: 'array', items: { type: 'string' }, description: 'The widening keys being accepted. Absent or empty when there is none.' },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Restored (or `unchanged` when the version is already the current one)',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: catalogKinds },
                  itemId: { type: 'string' },
                  restoredFrom: { type: 'integer' },
                  unchanged: { type: 'boolean' },
                  exists: { type: 'boolean' },
                  revision: revisionSummarySchema,
                  alsoChanged: { type: 'array', items: revisionSummarySchema, description: 'Other items that changed with it (cascade, rule renumbering).' },
                  widenings: { type: 'array', items: wideningSchema },
                  missingSecrets: { type: 'array', items: { type: 'string' }, description: '`env:<NAME>` or `header`: register them on the MCP screen.' },
                },
              }),
            ),
          },
          '401': failures['401'],
          '403': restoreFailures['403'],
          '404': failures['404'],
          '409': restoreFailures['409'],
          '422': restoreFailures['422'],
        },
      },
    },
    '/catalog/batches/{batchId}/revert': {
      post: {
        summary:
          'Reverts a batch (an import, or a previous revert): every item it touched goes back to its revision before the batch, in reverse order and, within a kind, what narrows before what widens — as a NEW batch (`kind: revert`) whose revisions carry its id. An item changed after the batch is skipped and listed in `conflicts` unless it is named in `overwrite`; the run stops at the first item that fails (`failed`). The new batch is `applied` when everything went back (the original becomes `reverted`), otherwise `partial`. Same widening rule as the restore, over the whole set. Administrators only (404 for the others)',
        parameters: [{ name: 'batchId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: false,
          ...json({
            type: 'object',
            properties: {
              confirm: { type: 'array', items: { type: 'string' }, description: 'The keys of ALL widenings of the revert.' },
              overwrite: { type: 'array', items: { type: 'string' }, description: 'Items (`<kind>/<itemId>`) changed after the batch to revert anyway, one by one.' },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Reverted (see `batch.status`)',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  batch: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      at: { type: 'string', format: 'date-time' },
                      by: { type: 'string' },
                      kind: { type: 'string', enum: ['import', 'revert'] },
                      scope: { type: 'string' },
                      summary: { type: 'object' },
                      widenings: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, itemId: { type: 'string' }, ...wideningSchema.properties } } },
                      status: { type: 'string', enum: ['applied', 'partial', 'reverted'] },
                    },
                  },
                  reverted: { type: 'array', items: { type: 'object' } },
                  unchanged: { type: 'array', items: { type: 'object' } },
                  conflicts: { type: 'array', items: { type: 'object' } },
                  failed: { type: 'object' },
                },
              }),
            ),
          },
          '401': failures['401'],
          '403': restoreFailures['403'],
          '404': failures['404'],
          '409': restoreFailures['409'],
          '422': failures['422'],
        },
      },
    },
    '/catalog/export': {
      get: {
        summary:
          'Exports the catalog as a package: text items (skills, commands, rules, specs, ADRs, knowledge, protocol addenda) as `.md` with frontmatter, structure (agents, MCPs, project, project permissions) as canonical JSON, under `global/` and `projects/<id>/`, plus `catalog.json` (the manifest, with the sha256 of every file). No secret leaves: the canonical documents carry none, and every text field (bodies, agent env, MCP url and args) also goes through the secret mask; `manifest.masked` lists what was masked (file, field, layer), never the value. Administrators only (404 for the others)',
        parameters: [
          { name: 'scope', in: 'query', schema: { type: 'string', default: 'all' }, description: '`all`, `global` or `project` (with `project`); `project:<id>` also works.' },
          { name: 'project', in: 'query', schema: { type: 'string' }, description: 'The project of `scope=project`.' },
          {
            name: 'format',
            in: 'query',
            schema: { type: 'string', enum: ['tar', 'json'], default: 'tar' },
            description: '`tar`: a `.tar.gz` with the `catalog/` folder; `json`: `{ manifest, files }`.',
          },
        ],
        responses: {
          '200': {
            description: 'The package',
            content: {
              'application/gzip': { schema: { type: 'string', format: 'binary' } },
              'application/json': {
                schema: envelope({
                  type: 'object',
                  properties: {
                    manifest: {
                      type: 'object',
                      properties: {
                        format: { type: 'integer' },
                        scope: { type: 'string' },
                        gateway: { type: 'string' },
                        exportedAt: { type: 'string', format: 'date-time' },
                        exportedBy: { type: 'string' },
                        files: { type: 'object', additionalProperties: { type: 'string' } },
                        masked: { type: 'array', items: { type: 'object' } },
                      },
                    },
                    files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Path → content (UTF-8, LF), `catalog.json` included.' },
                  },
                }),
              },
            },
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/catalog/import/plan': {
      post: {
        summary:
          'The import PLAN (dry-run): NOTHING is written. Takes the package of the export — the `.tar.gz` (`Content-Type: application/gzip`) or `{ manifest, files }` as JSON — or the canonical documents (`{ documents }`, the importer) and returns, per item, the operation (`create`, `update`, `unchanged`, `conflict`, `error`; never `delete`: only create and update, the mirror mode comes later), the diff against the current item, the access widenings (the `confirm` of the apply), the attentions, the broken references (attached doc, resource, initial context, `mcp:` and `agent:` that exist neither in the catalog nor in the package), the problems under the same rules as the screens, the secrets the vault still lacks (an enabled MCP missing one enters disabled), the apply ORDER (project → docs → resources → rules → addenda → MCPs → agents → links → project permissions; inside a phase, the cited before who cites and what restricts before what widens) and the `planHash` (sha256 of the package documents, the current state used and the outcome: the apply only runs if it is still the same). Body limit: `CATALOG_IMPORT_LIMIT`. Administrators only (404 for the others); an access token also plans, but `caller.wideningsApplicable` is false: widenings are applied only by an administrator on the screen',
        parameters: [
          {
            name: 'scope',
            in: 'query',
            schema: { type: 'string' },
            description: '`all`, `global` or `project` (with `project`); `project:<id>` also works. Absent: the scope of the manifest, else `all`.',
          },
          { name: 'project', in: 'query', schema: { type: 'string' }, description: 'The project of `scope=project`.' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/gzip': { schema: { type: 'string', format: 'binary' } },
            'application/json': {
              schema: {
                type: 'object',
                required: ['files'],
                properties: {
                  manifest: { type: 'object', description: 'The `catalog.json` (optional when it is inside `files`).' },
                  files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Path → content, as GET /catalog/export?format=json returns.' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The plan',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  scope: { type: 'string' },
                  planHash: { type: 'string' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        ref: { type: 'string', description: '`<kind>/<id>` (MCP: the server key), as in the history.' },
                        kind: { type: 'string', enum: catalogKinds },
                        id: { type: 'string' },
                        projectId: { type: 'string' },
                        op: { type: 'string', enum: ['create', 'update', 'unchanged', 'conflict', 'error', 'delete'] },
                        hash: { type: 'string' },
                        currentHash: { type: 'string' },
                        diff: { type: 'object', description: 'As in GET /catalog/history/diff.' },
                        widenings: { type: 'array', items: wideningSchema },
                        attentions: { type: 'array', items: { type: 'object' } },
                        issues: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
                        brokenRefs: { type: 'array', items: { type: 'object' } },
                        missingSecrets: { type: 'array', items: { type: 'string' } },
                        entersDisabled: { type: 'boolean' },
                        blockedByToken: { type: 'boolean' },
                      },
                    },
                  },
                  order: { type: 'array', items: { type: 'object' }, description: 'The `create`/`update` items in apply order, with `phase`.' },
                  widenings: { type: 'array', items: wideningSchema },
                  attentions: { type: 'array', items: { type: 'object' } },
                  brokenRefs: { type: 'array', items: { type: 'object' } },
                  missingSecrets: { type: 'array', items: { type: 'object' } },
                  fileErrors: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } },
                  summary: { type: 'object' },
                  caller: { type: 'object', properties: { viaAccessToken: { type: 'boolean' }, wideningsApplicable: { type: 'boolean' } } },
                },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '413': { description: 'The package is too large (body or unpacked)' },
          '422': failures['422'],
        },
      },
    },
    '/catalog/import/apply': {
      post: {
        summary:
          'APPLIES the import. Takes `{ package | documents, scope?, planHash, confirm? }` (JSON only), recomputes the plan and refuses, writing NOTHING: `planHash` differs from the plan computed now (409 `plan_changed`, `details.plan` is the new plan); an item is `error`/`conflict` or a file is out of format (422 `import_blocked`, `details.blockers`); the plan widens access and `confirm` is not exactly its set (409 `widening_confirmation_required`) or the request came with an access token (403: widenings only by an administrator signed in on the screen). Then writes in the ORDER of the plan, through the same write path and validations as the screens, every write a revision (`op: import`, `source: import`) inside ONE batch (`kind: import`, opened as `partial` before the first write). The project whose initial context cites a new doc goes in two steps (`record` without it, then `links`). An MCP missing a secret enters disabled (`entersDisabled`, `missingSecrets`). It stops at the first step that fails: the batch stays `partial`, with `failed`, `pending` and `revert` (POST /catalog/batches/{batchId}/revert). Nothing to write (all `unchanged`): no batch. Administrators only (404 for the others)',
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['planHash'],
            properties: {
              package: { type: 'object', properties: { manifest: { type: 'object' }, files: { type: 'object', additionalProperties: { type: 'string' } } } },
              documents: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['kind', 'id', 'body'],
                  properties: { kind: { type: 'string', enum: catalogKinds }, id: { type: 'string' }, projectId: { type: 'string' }, body: { type: 'object' } },
                },
                description: 'Canonical documents (instead of `package`).',
              },
              scope: { type: 'string', description: '`all`, `global` or `project:<id>`. Absent: the query (`scope`/`project`), the manifest, else `all`.' },
              planHash: { type: 'string', description: 'The `planHash` of the plan the person reviewed.' },
              confirm: { type: 'array', items: { type: 'string' }, description: 'The widening keys being accepted: exactly those of the plan.' },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Applied (see `batch.status`: `applied`, or `partial` with `failed`)',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  planHash: { type: 'string' },
                  batch: { type: 'object' },
                  applied: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { ref: { type: 'string' }, op: { type: 'string' }, phase: { type: 'string' }, part: { type: 'string' }, revision: { type: 'integer' } },
                    },
                  },
                  failed: {
                    type: 'object',
                    properties: { ref: { type: 'string' }, part: { type: 'string' }, message: { type: 'string' }, issues: { type: 'array', items: { type: 'object' } } },
                  },
                  pending: { type: 'array', items: { type: 'object' } },
                  widenings: { type: 'array', items: wideningSchema },
                  entersDisabled: { type: 'array', items: { type: 'string' } },
                  missingSecrets: { type: 'array', items: { type: 'object' } },
                  revert: { type: 'object', properties: { batchId: { type: 'string' }, method: { type: 'string' }, path: { type: 'string' } } },
                },
              }),
            ),
          },
          '401': failures['401'],
          '403': restoreFailures['403'],
          '404': failures['404'],
          '409': {
            description: 'Code `plan_changed` (`details.plan`) or `widening_confirmation_required` (`details.widenings`)',
            content: { 'application/json': { schema: failureEnvelope } },
          },
          '413': { description: 'The body is too large' },
          '422': {
            description: 'Invalid body, or code `import_blocked`: items that cannot be applied (`details.blockers`)',
            content: { 'application/json': { schema: failureEnvelope } },
          },
        },
      },
    },
    '/catalog/batches': {
      get: {
        summary:
          'The catalog batches (imports and reverts), newest first: status (`applied`, `partial`, `reverted`), summary, the widenings accepted item by item, and how many items each one touched. Administrators only (404 for the others)',
        parameters: [
          { name: 'project', in: 'query', schema: { type: 'string' }, description: 'A project id (its scope, or batches that wrote in it), `global`, or absent (all).' },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['import', 'revert'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: {
          '200': {
            description: 'A page of batches',
            ...json(
              envelope({
                type: 'object',
                properties: { batches: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer' } },
              }),
            ),
          },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/catalog/batches/{batchId}': {
      get: {
        summary: 'One batch, whole, and its revisions (without the document) in the order they were written. Administrators only (404 for the others)',
        parameters: [{ name: 'batchId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'The batch',
            ...json(envelope({ type: 'object', properties: { batch: { type: 'object' }, revisions: { type: 'array', items: revisionSummarySchema } } })),
          },
          '401': failures['401'],
          '404': failures['404'],
        },
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
        parameters: [guidanceScope, { name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: ['spec', 'adr', 'knowledge'] } }],
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
    '/docs/{id}/import-issues/resolve': {
      post: {
        summary:
          'Mark an import issue of the document as RESOLVED (a pending one: DISCARD — what it held back is forgotten): the issues with this code (and target, when given) leave it; the rest stays. `{ pending: true }` discards every pending issue at once. Recorded in the catalog history. Administrators only; 404 when no issue matches',
        parameters: idParam,
        requestBody: { required: true, ...json(importIssueMatch) },
        responses: { '200': { description: 'OK', ...json(envelope(docSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/resources/{id}/import-issues/resolve': {
      post: {
        summary:
          'Mark an import issue of the skill or command as RESOLVED (a pending one: DISCARD — what it held back is forgotten): the issues with this code (and target, when given) leave it; the rest stays. `{ pending: true }` discards every pending issue at once. Recorded in the catalog history. Administrators only; 404 when no issue matches',
        parameters: idParam,
        requestBody: { required: true, ...json(importIssueMatch) },
        responses: { '200': { description: 'OK', ...json(envelope(resourceSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/agents/{agentId}/import-issues/resolve': {
      post: {
        summary:
          'Mark an import issue of the agent as RESOLVED (a pending one: DISCARD — what it held back is forgotten): the issues with this code (and target, when given) leave it; the rest stays. `{ pending: true }` discards every pending issue at once. Recorded in the catalog history. Administrators only; 404 when no issue matches',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json(importIssueMatch) },
        responses: { '200': { description: 'OK', ...json(envelope(agentDetailSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/agents/{agentId}/ledger': {
      get: {
        summary:
          "The agent's ledger (its durable learning memory): the contexts without their content (theme, trigger, line count, last change), the total of lines and the health warnings. Administrators only; 404 for an unknown agent",
        parameters: ledgerParams,
        responses: { '200': { description: 'OK', ...json(envelope(ledgerIndexSchema)) }, '404': failures['404'] },
      },
    },
    '/agents/{agentId}/ledger/search': {
      get: {
        summary: 'Lines and contexts of the agent ledger matching every word of `q` (accent and case insensitive; triggers, lines and playbooks). Administrators only',
        parameters: [...ledgerParams, { name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  agentId: { type: 'string' },
                  query: { type: 'string' },
                  contexts: { type: 'array', items: { type: 'object', properties: ledgerSummaryFields } },
                  lines: { type: 'array', items: { type: 'object', properties: { ...ledgerLineSchema.properties, topic: { type: 'string' } } } },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
    },
    '/agents/{agentId}/ledger/export': {
      get: {
        summary:
          'The agent ledger in the legacy folder format: `<agent>-ledger/index.md` (the trigger map) and `contextos/<topic>.md` (lines, playbook, `@trigger` in the [AKM-STAMP]). `format=tar` (default) returns a `.tar.gz`; `format=json`, `{ files: { path: content } }`. Administrators only',
        parameters: [...ledgerParams, { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['tar', 'json'] } }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/gzip': { schema: { type: 'string', format: 'binary' } },
              'application/json': { schema: envelope({ type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } } } }) },
            },
          },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/agents/{agentId}/ledger/contexts': {
      post: {
        summary:
          'Create a context in the agent ledger: the theme (normalized to a slug), the one-line trigger (≥ 15 characters) and an optional markdown playbook. Recorded as a revision with the administrator as author. Administrators only',
        parameters: ledgerParams,
        requestBody: {
          required: true,
          ...json({ type: 'object', required: ['topic', 'trigger'], properties: { topic: { type: 'string' }, trigger: { type: 'string' }, playbook: { type: 'string' } } }),
        },
        responses: ledgerWriteResponses('201'),
      },
    },
    '/agents/{agentId}/ledger/contexts/{topic}': {
      get: {
        summary: 'One context in full: trigger, playbook and lines (with ids). Administrators only',
        parameters: ledgerTopicParams,
        responses: { '200': { description: 'OK', ...json(envelope(ledgerContextSchema)) }, '404': failures['404'] },
      },
      put: {
        summary: 'Change the trigger and/or the playbook (empty clears it) of a context; one revision per field that changed. Administrators only',
        parameters: ledgerTopicParams,
        requestBody: { required: true, ...json({ type: 'object', properties: { trigger: { type: 'string' }, playbook: { type: 'string' } } }) },
        responses: ledgerWriteResponses('200'),
      },
      delete: {
        summary: 'Delete a context and its lines; the revision keeps what left (trigger, playbook, lines). Administrators only',
        parameters: ledgerTopicParams,
        responses: ledgerWriteResponses('200'),
      },
    },
    '/agents/{agentId}/ledger/contexts/{topic}/revisions': {
      get: {
        summary:
          'The revisions of a theme, newest first: who (agent and conversation, or administrator), when, the action and the before/after. Kept after the context is deleted. Administrators only',
        parameters: ledgerTopicParams,
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: ledgerRevisionSchema })) }, '404': failures['404'] },
      },
    },
    '/agents/{agentId}/ledger/contexts/{topic}/lines': {
      post: {
        summary: 'Add a line `[DATE] | TYPE | trigger | learning | ref` to a context. Administrators only',
        parameters: ledgerTopicParams,
        requestBody: { required: true, ...json({ ...ledgerLineBody, required: ['type', 'trigger', 'learning'] }) },
        responses: ledgerWriteResponses('201'),
      },
    },
    '/agents/{agentId}/ledger/contexts/{topic}/lines/{lineId}': {
      put: {
        summary: 'Change only the fields sent of a line. Administrators only',
        parameters: ledgerLineParams,
        requestBody: { required: true, ...json(ledgerLineBody) },
        responses: ledgerWriteResponses('200'),
      },
      delete: {
        summary: 'Delete a line (the revision keeps it). Administrators only',
        parameters: ledgerLineParams,
        responses: ledgerWriteResponses('200'),
      },
    },
    '/agents/{agentId}/system-prompt': {
      get: {
        summary:
          'The final system prompt the agent receives in a new conversation (the self MCP `preview_system_prompt`), composed as the provider lanes compose it, with characters and estimated tokens per part. `project`: the conversation project, for a global agent. Administrators only',
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
                  agentId: { type: 'string' },
                  projectId: { type: 'string' },
                  prompt: { type: 'string' },
                  chars: { type: 'integer' },
                  tokens: { type: 'integer' },
                  parts: {
                    type: 'array',
                    items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, chars: { type: 'integer' }, tokens: { type: 'integer' } } },
                  },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
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
                  cli: {
                    type: 'object',
                    description:
                      'Only when the agent offers Codex or Antigravity: they get the assembled prompt as one command-line argument, and Linux refuses one above 128 KiB. `bytes` is the estimated argument (the larger among the agent CLIs), `warnAt` is where the screen warns (never blocks), `parts` are the raw prompt parts in bytes.',
                    properties: {
                      providers: { type: 'array', items: { type: 'string' } },
                      bytes: { type: 'integer' },
                      limit: { type: 'integer' },
                      warnAt: { type: 'integer' },
                      parts: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, bytes: { type: 'integer' } } } },
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
    '/files': {
      post: {
        summary:
          'Upload the content of a RESOURCE FILE (a script or template of a skill, command or agent): stored by sha256, returned as {sha256, bytes}; the resource list points to it afterwards. Text only, up to 1 MB, and no secrets (422): the script reads credentials from a gateway variable. Administrators only',
        requestBody: { required: true, ...json({ type: 'object', properties: { content: { type: 'string', description: 'The file content, base64' } }, required: ['content'] }) },
        responses: {
          '200': { description: 'Stored', ...json(envelope({ type: 'object', properties: { sha256: { type: 'string' }, bytes: { type: 'integer' } } })) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/files/{sha256}': {
      get: {
        summary: 'The content of a stored resource file, as text. Administrators only',
        parameters: [{ name: 'sha256', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { sha256: { type: 'string' }, bytes: { type: 'integer' }, text: { type: 'string' } } })) },
          '401': failures['401'],
          '404': failures['404'],
        },
      },
    },
    '/resources/{id}/files': {
      put: {
        summary:
          'Replace the FILES of a skill or command (the rest stays): the folder <data>/global|projects/<p>/skills|commands/<id>/ is rewritten whole, read-only for agents. Every content must be uploaded first. Administrators only',
        parameters: idParam,
        requestBody: { required: true, ...json({ type: 'object', properties: { files: resourceFiles }, required: ['files'] }) },
        responses: { '200': { description: 'OK', ...json(envelope(resourceSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/agents/{agentId}/files': {
      put: {
        summary:
          'Replace the FILES of an agent (the rest stays): its folder is rewritten whole, read-only for the agent. Every content must be uploaded first. Administrators only',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json({ type: 'object', properties: { files: resourceFiles }, required: ['files'] }) },
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { files: resourceFiles } })) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
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
    '/protocols/{kind}': {
      get: {
        summary:
          'How a skill, command, rule, spec, ADR or knowledge study must be built: the core protocol (shipped with the gateway, versioned) and the administrators addenda — the global one and, with ?project=, the project one. The builder follows both. Administrators only',
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['skill', 'command', 'rule', 'spec', 'adr', 'knowledge'] } },
          { name: 'project', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK', ...json(envelope(protocolView)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/protocols/{kind}/addendum': {
      put: {
        summary:
          'Write the addendum of a scope (absent or null projectId = global). It goes AFTER the core protocol and never replaces it; an empty body deletes it. Administrators only',
        parameters: [{ name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['skill', 'command', 'rule', 'spec', 'adr', 'knowledge'] } }],
        requestBody: {
          required: true,
          ...json({ type: 'object', required: ['body'], properties: { projectId: { type: 'string', nullable: true }, body: { type: 'string' } } }),
        },
        responses: { '200': { description: 'OK', ...json(envelope(protocolView)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/agents/{agentId}/commands': {
      get: {
        summary:
          'The /commands, skills and documents the caller may use with this agent — id, kind and description only (the composer autocomplete). A skill picked with /name goes in full, already loaded; a document is /<kind>:<id> (spec, adr, knowledge) and goes in full too. Documents: the global ones plus those of `project` (the conversation project). Anyone who can talk to the agent',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'project', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['command', 'skill', 'spec', 'adr', 'knowledge'] }, description: { type: 'string' } },
                },
              }),
            ),
          },
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
    '/secret-mask': {
      get: {
        summary:
          'The secret mask: values to mask (never returned), extra field names that mean secret or never do, and the latest hits (metadata only). Administrators only (404 otherwise)',
        description:
          'Tool output, recorded turns and what the screen receives pass through three layers: known values (accounts, provider keys, these values; also base64 and the password inside a URI), shape (a secret-like field name with an opaque value in JSON, YAML or .env) and known token formats. `kubectl get secret -o json|yaml|jsonpath` is refused.',
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'object', additionalProperties: true })) }, '404': failures['404'] },
      },
    },
    '/secret-mask/values/{id}': {
      put: {
        summary: 'Add or update a value to mask. The value goes in and never comes back; left out, the stored one stays. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label'] } } },
        },
        responses: { '200': { description: 'Saved', ...json(envelope({ type: 'object', additionalProperties: true })) }, '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Stop masking a value. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Removed', ...json(envelope({ type: 'object', additionalProperties: true })) }, '404': failures['404'] },
      },
    },
    '/secret-mask/names': {
      put: {
        summary: 'Replace the extra field names that mean secret (`secret`) and those that never do (`safe`). Administrators only',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { secret: { type: 'array', items: { type: 'string' } }, safe: { type: 'array', items: { type: 'string' } } },
                required: ['secret', 'safe'],
              },
            },
          },
        },
        responses: { '200': { description: 'Saved', ...json(envelope({ type: 'object', additionalProperties: true })) }, '404': failures['404'], '422': failures['422'] },
      },
    },
    '/secret-mask/test': {
      post: {
        summary: 'How a text would come out of the mask. Administrators only',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } } },
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { masked: { type: 'string' } } })) }, '404': failures['404'] },
      },
    },
    '/projects/{projectId}/accounts': {
      get: {
        summary: "The accounts of a project: the credentials its agents' terminal receives (GitHub, secret variables). Never the secret. Administrators only (404 otherwise)",
        description:
          'Each command gets only the accounts the permissions let that agent use (`account <id>`). A GitHub App goes in as a 1-hour installation token; its private key stays in the gateway.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(envelope({ type: 'object', properties: { projectId: { type: 'string' }, accounts: { type: 'array', items: projectAccountSchema } } })),
          },
          '404': failures['404'],
        },
      },
    },
    '/projects/{projectId}/accounts/{accountId}': {
      put: {
        summary: 'Create or update an account. The secret goes in and never comes back; left out on an update, the stored one stays. Administrators only',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'accountId', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,47}$' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['github-app', 'github-token', 'git-https', 'gcp-service-account', 'ssh-ca', 'ssh-key', 'secret-env', 'turn-callback'] },
                  label: { type: 'string' },
                  public: {
                    type: 'object',
                    properties: {
                      owner: { type: 'string' },
                      baseUrl: { type: 'string', description: 'git-https: https URL (host and optional path prefix) the credential helper is scoped to' },
                      username: { type: 'string', description: 'git-https: the git server user' },
                      appId: { type: 'string' },
                      installationId: { type: 'string' },
                      repositories: { type: 'array', items: { type: 'string' } },
                      envName: { type: 'string' },
                      callbackHost: {
                        type: 'string',
                        description:
                          'turn-callback: the `host` or `host:port` that receives the end-of-turn notice of this project conversations; its secret signs each one. Never reaches an agent command.',
                      },
                      gcpProject: { type: 'string' },
                      principals: { type: 'array', items: { type: 'string' } },
                      validityMinutes: { type: 'integer', minimum: 1, maximum: 60 },
                      hostPatterns: { type: 'array', items: { type: 'string' } },
                      knownHosts: { type: 'string' },
                      certificate: { type: 'string' },
                    },
                  },
                  secret: {
                    type: 'string',
                    description:
                      'The App private key (.pem), the token, the service account JSON, the SSH private key or the value. An SSH CA is generated by the gateway: nothing to send',
                  },
                },
                required: ['kind'],
              },
            },
          },
        },
        responses: { '200': { description: 'Saved', ...json(envelope(projectAccountSchema)) }, '422': failures['422'], '404': failures['404'] },
      },
      delete: {
        summary: 'Remove an account: the agents stop receiving it at once. Administrators only',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'accountId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Removed', ...json(envelope({ type: 'object', properties: { removed: { type: 'string' } } })) }, '404': failures['404'] },
      },
    },
    '/projects/{projectId}/accounts/{accountId}/test': {
      post: {
        summary: 'Mint the token (or check the secret) and say what it reaches, without returning it. Administrators only',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'accountId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } })) },
          '404': failures['404'],
        },
      },
    },
    '/agents/{agentId}/permission-rules': {
      get: {
        summary:
          "An agent's permission rules, its project's rules and its open permission requests (the self MCP `list_permission_rules`). Administrators, or the agent itself: the `x-gateway-conversation` header must be a live session with a running turn of this agent, owned by the caller (404 otherwise)",
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  agentId: { type: 'string' },
                  agentName: { type: 'string' },
                  projectId: { type: 'string' },
                  rules: { type: 'array', items: permissionRuleSchema },
                  project: { type: 'object', properties: { projectId: { type: 'string' }, rules: { type: 'array', items: permissionRuleSchema } } },
                  pending: { type: 'array', items: permissionRequestSchema },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
      post: {
        summary:
          "Change an agent's permission rules on behalf of an agent (the self MCP `save_permission_rules`). Restrictions (add a `deny`, remove an `allow`) apply at once, recorded in the catalog history with the reason; widenings (add an `allow`, remove a `deny`, as the catalog widening detector defines them) are NOT applied: they become one pending permission request that only an administrator signed in on the screen can approve. Administrators only",
        description:
          'Every rule goes through the same validator as the agent form; all problems come back at once (422). `notice` is the text the agent must relay to the person (pt-BR): what was applied and, if any, what is pending and where to confirm it. The `x-gateway-agent` and `x-gateway-conversation` headers (sent by the gateway to its own MCP) label who asked; they never grant anything.',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['reason'],
            properties: {
              add: { type: 'array', items: permissionRuleSchema, maxItems: 50 },
              remove: { type: 'array', items: permissionRuleSchema, maxItems: 50, description: 'Each must match a rule the agent has (category, pattern, decision).' },
              reason: { type: 'string', maxLength: 1000, description: 'Why: shown to the administrator who confirms.' },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Restrictions applied; widenings (if any) pending',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  agentId: { type: 'string' },
                  applied: { type: 'object', properties: { add: { type: 'array', items: permissionRuleSchema }, remove: { type: 'array', items: permissionRuleSchema } } },
                  pending: permissionRequestSchema,
                  rules: { type: 'array', items: permissionRuleSchema, description: 'The agent rules now (the pending ones are not in it).' },
                  notice: { type: 'string' },
                },
              }),
            ),
          },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/agents/{agentId}/permission-requests': {
      get: {
        summary: "An agent's permission requests: the open ones (pending and expired) by default, `status=all` adds the decided ones. Administrators only",
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'all'] } },
        ],
        responses: { '200': { description: 'OK, newest first', ...json(envelope({ type: 'array', items: permissionRequestSchema })) }, '404': failures['404'] },
      },
    },
    '/projects/{projectId}/permission-rules': {
      get: {
        summary:
          "A project's permission rules (the project layer) and its open permission requests (the self MCP `list_permission_rules` with scope `project`). Administrators only (404 otherwise)",
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  agentId: { type: 'string' },
                  agentName: { type: 'string' },
                  projectId: { type: 'string' },
                  rules: { type: 'array', items: permissionRuleSchema },
                  project: { type: 'object', properties: { projectId: { type: 'string' }, rules: { type: 'array', items: permissionRuleSchema } } },
                  pending: { type: 'array', items: permissionRequestSchema },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
      post: {
        summary:
          "Change a project's permission rules (the project layer) on behalf of an agent (the self MCP `save_permission_rules` with scope `project`). Restrictions (add a `deny`, remove an `allow`) apply at once, recorded in the catalog history with the reason; widenings (add an `allow`, remove a `deny`, as the catalog widening detector defines them) are NOT applied: they become one pending permission request that only an administrator signed in on the screen can approve. Administrators only",
        description:
          'Every rule goes through the same validator as the agent form; all problems come back at once (422). `notice` is the text the agent must relay to the person (pt-BR): what was applied and, if any, what is pending and where to confirm it. The `x-gateway-agent` and `x-gateway-conversation` headers (sent by the gateway to its own MCP) label who asked; they never grant anything.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['reason'],
            properties: {
              add: { type: 'array', items: permissionRuleSchema, maxItems: 50 },
              remove: { type: 'array', items: permissionRuleSchema, maxItems: 50, description: 'Each must match a rule the agent has (category, pattern, decision).' },
              reason: { type: 'string', maxLength: 1000, description: 'Why: shown to the administrator who confirms.' },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Restrictions applied; widenings (if any) pending',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  agentId: { type: 'string' },
                  applied: { type: 'object', properties: { add: { type: 'array', items: permissionRuleSchema }, remove: { type: 'array', items: permissionRuleSchema } } },
                  pending: permissionRequestSchema,
                  rules: { type: 'array', items: permissionRuleSchema, description: 'The agent rules now (the pending ones are not in it).' },
                  notice: { type: 'string' },
                },
              }),
            ),
          },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{projectId}/permission-requests': {
      get: {
        summary: "The permission requests for a project's rules: the open ones (pending and expired) by default, `status=all` adds the decided ones. Administrators only",
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'all'] } },
        ],
        responses: { '200': { description: 'OK, newest first', ...json(envelope({ type: 'array', items: permissionRequestSchema })) }, '404': failures['404'] },
      },
    },
    '/permission-requests': {
      get: {
        summary: 'Every permission request: the open ones (pending and expired) by default, `status=all` adds the decided ones; `agentId` filters. Administrators only',
        parameters: [
          { name: 'agentId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'projectId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'all'] } },
        ],
        responses: { '200': { description: 'OK, newest first', ...json(envelope({ type: 'array', items: permissionRequestSchema })) }, '404': failures['404'] },
      },
    },
    '/permission-requests/{requestId}/approve': {
      post: {
        summary:
          "Approve a pending permission request: its rules are written through the agent's normal write path, with the accepted widening keys recorded in the revision. ONLY an administrator signed in on the screen (the session cookie): an access token, an MCP client or an agent (any credential in `X-Tool-Authorization`) gets 403. Administrators only",
        description:
          'The widenings are recomputed on the agent as it is NOW, and `confirm` must be exactly that set (as in the catalog import and rollback). If the agent changed since the screen read it, 409 `widening_confirmation_required` with the new `details.widenings`. A request pending for more than 7 days is expired and cannot be approved.',
        parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              confirm: { type: 'array', items: { type: 'string' }, description: 'The widening keys being accepted.' },
              value: {
                type: 'string',
                maxLength: 16384,
                description: 'Kind `secret` only: the value of the requested variable, typed on the screen. It goes straight to the vault, never to the request.',
              },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Approved',
            ...json(envelope({ type: 'object', properties: { request: permissionRequestSchema, permissions: { type: 'array', items: permissionRuleSchema } } })),
          },
          '403': { description: 'Code `forbidden`: not an administrator signed in on the screen.', ...json(failureEnvelope) },
          '404': failures['404'],
          '409': {
            description:
              'Code `widening_confirmation_required`: `confirm` is not exactly `details.widenings` (the agent may have changed). Code `permission_request_closed`: already decided, or expired (`details.status`).',
            ...json(failureEnvelope),
          },
        },
      },
    },
    '/permission-requests/{requestId}/reject': {
      post: {
        summary: 'Reject a pending (or expired) permission request: nothing changes on the agent. Administrators only',
        parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: false, ...json({ type: 'object', properties: { note: { type: 'string', maxLength: 500 } } }) },
        responses: {
          '200': { description: 'Rejected', ...json(envelope(permissionRequestSchema)) },
          '404': failures['404'],
          '409': { description: 'Code `permission_request_closed`: already decided.', ...json(failureEnvelope) },
        },
      },
    },
    '/agents/{agentId}/secrets': {
      get: {
        summary: 'The SECRET VARIABLES of this agent: names, descriptions and when they changed — never the value. Administrators only (404 otherwise)',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    scope: { type: 'string', enum: ['agent', 'skill', 'command'] },
                    scopeId: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    updatedAt: { type: 'string', format: 'date-time' },
                    updatedBy: { type: 'string' },
                  },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
    },
    '/agents/{agentId}/secrets/{name}': {
      put: {
        summary:
          'Set a secret variable (the value only goes in: no route returns it). ⛔ Only an administrator on the screen (the login cookie, not an access token or an agent). Without `value`, only the description changes',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,63}$' } },
        ],
        requestBody: { required: true, ...json({ type: 'object', properties: { value: { type: 'string', maxLength: 16384 }, description: { type: 'string', maxLength: 300 } } }) },
        responses: {
          '200': {
            description: 'Saved (without the value)',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  scope: { type: 'string', enum: ['agent', 'skill', 'command'] },
                  scopeId: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  updatedAt: { type: 'string', format: 'date-time' },
                  updatedBy: { type: 'string' },
                },
              }),
            ),
          },
          '403': { description: 'Not on the screen', ...json(failureEnvelope) },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
      delete: {
        summary: 'Delete a secret variable. ⛔ Only an administrator on the screen',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Deleted', ...json(envelope({ type: 'null' })) },
          '403': { description: 'Not on the screen', ...json(failureEnvelope) },
          '404': failures['404'],
        },
      },
    },
    '/resources/{resourceId}/secrets': {
      get: {
        summary: 'The SECRET VARIABLES of this skill or command: names, descriptions and when they changed — never the value. Administrators only (404 otherwise)',
        parameters: [{ name: 'resourceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    scope: { type: 'string', enum: ['agent', 'skill', 'command'] },
                    scopeId: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    updatedAt: { type: 'string', format: 'date-time' },
                    updatedBy: { type: 'string' },
                  },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
    },
    '/resources/{resourceId}/secrets/{name}': {
      put: {
        summary:
          'Set a secret variable (the value only goes in: no route returns it). ⛔ Only an administrator on the screen (the login cookie, not an access token or an agent). Without `value`, only the description changes',
        parameters: [
          { name: 'resourceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,63}$' } },
        ],
        requestBody: { required: true, ...json({ type: 'object', properties: { value: { type: 'string', maxLength: 16384 }, description: { type: 'string', maxLength: 300 } } }) },
        responses: {
          '200': {
            description: 'Saved (without the value)',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  scope: { type: 'string', enum: ['agent', 'skill', 'command'] },
                  scopeId: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  updatedAt: { type: 'string', format: 'date-time' },
                  updatedBy: { type: 'string' },
                },
              }),
            ),
          },
          '403': { description: 'Not on the screen', ...json(failureEnvelope) },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
      delete: {
        summary: 'Delete a secret variable. ⛔ Only an administrator on the screen',
        parameters: [
          { name: 'resourceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Deleted', ...json(envelope({ type: 'null' })) },
          '403': { description: 'Not on the screen', ...json(failureEnvelope) },
          '404': failures['404'],
        },
      },
    },
    '/resources/{id}/files/import': {
      post: {
        summary:
          'Copy files into the skill or command from a folder of the project (its repositories), on the server: the caller only points the path. Left out with the reason: node_modules, .git, .env*, .credentials, private keys, binaries, files over 1 MB and any file with a secret. Adds to the current list (same path replaces); `remove` drops paths or folders. Administrators only',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['from'],
            properties: {
              from: { type: 'string', description: 'A file or folder relative to the project folder, e.g. repositories/<repo>/.agents/skills/<id>/scripts.' },
              to: { type: 'string', description: 'Where inside the resource (default: its root).' },
              remove: { type: 'array', items: { type: 'string' } },
              projectId: { type: 'string', description: 'Only for a global resource: the project whose folder holds `from`.' },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Imported',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  added: { type: 'array', items: { type: 'string' } },
                  skipped: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } } } },
                  files: { type: 'array', items: { type: 'string' } },
                },
              }),
            ),
          },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/agents/{agentId}/files/import': {
      post: {
        summary:
          'Copy files into the agent from a folder of the project (its repositories), on the server: the caller only points the path. Left out with the reason: node_modules, .git, .env*, .credentials, private keys, binaries, files over 1 MB and any file with a secret. Adds to the current list (same path replaces); `remove` drops paths or folders. Administrators only',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['from'],
            properties: {
              from: { type: 'string', description: 'A file or folder relative to the project folder, e.g. repositories/<repo>/.agents/skills/<id>/scripts.' },
              to: { type: 'string', description: 'Where inside the resource (default: its root).' },
              remove: { type: 'array', items: { type: 'string' } },
              projectId: { type: 'string', description: 'Only for a global resource: the project whose folder holds `from`.' },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Imported',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  added: { type: 'array', items: { type: 'string' } },
                  skipped: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } } } },
                  files: { type: 'array', items: { type: 'string' } },
                },
              }),
            ),
          },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/conversations/{id}/archive': {
      put: {
        summary:
          'Archive (or unarchive) a conversation: it leaves the inbox (listed with `?archived=1`), is not resumed by itself (a delegation refuses it), and nothing is deleted. Sending a message to it unarchives it. The same people who can delete it',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: false, ...json({ type: 'object', properties: { archived: { type: 'boolean', description: 'false unarchives. Default true.' } } }) },
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { id: { type: 'string' }, archived: { type: 'boolean' } } })) },
          '404': failures['404'],
        },
      },
    },
    '/errors': {
      get: {
        summary:
          'The error log of the conversations: tool calls that failed, turns that ended in error, interrupted turns — newest first, with counts by kind and by tool. Administrators only',
        parameters: [
          { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 90 }, description: 'Default 7.' },
          { name: 'agentId', in: 'query', schema: { type: 'string' } },
          { name: 'tool', in: 'query', schema: { type: 'string' } },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['tool', 'turn', 'aborted'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        at: { type: 'string', format: 'date-time' },
                        kind: { type: 'string', enum: ['tool', 'turn', 'aborted'] },
                        conversationId: { type: 'string' },
                        turn: { type: 'integer' },
                        agentId: { type: 'string' },
                        title: { type: 'string' },
                        tool: { type: 'string' },
                        message: { type: 'string' },
                      },
                    },
                  },
                  byKind: { type: 'object', additionalProperties: { type: 'integer' } },
                  byTool: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, count: { type: 'integer' } } } },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
    },
    '/conversations/{id}/panel': {
      get: {
        summary:
          'The PANEL of a conversation: the goal, items (queued, doing, blocked, done, dropped — with notes, links and the agent doing it), decisions, questions and the timeline. The agent keeps it with the conversation_panel tool. `?format=md` returns Markdown. Who can see the conversation',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['md'] } },
        ],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'object' })) }, '404': failures['404'] },
      },
      patch: {
        summary: 'Change the panel (the person correcting it): one operation — set_goal, add, update (status, note, links), move, decide, ask, answer',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({ type: 'object', required: ['op'], properties: { op: { type: 'string', enum: ['set_goal', 'add', 'update', 'move', 'decide', 'ask', 'answer'] } } }),
        },
        responses: { '200': { description: 'The panel', ...json(envelope({ type: 'object' })) }, '404': failures['404'], '422': failures['422'] },
      },
    },
    '/secret-requests': {
      post: {
        summary:
          'An agent asks for a SECRET VARIABLE by name: a pending request (kind `secret`) in Notifications; the administrator types the value on the screen when approving (`value` on the approve body). Administrators only',
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['scope', 'scopeId', 'name', 'reason'],
            properties: {
              scope: { type: 'string', enum: ['agent', 'skill', 'command'] },
              scopeId: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              reason: { type: 'string' },
            },
          }),
        },
        responses: { '200': { description: 'Pending request', ...json(envelope(permissionRequestSchema)) }, '404': failures['404'], '422': failures['422'] },
      },
    },
    '/projects/{projectId}/permissions': {
      get: {
        summary: 'The permission rules of a project (the project layer), plus the fixed system rules. Administrators only (404 otherwise)',
        description:
          'Layers: system (fixed denies: secrets, gateway data, destructive commands) → agent (`IAgent.permissions`) → project → no rule = deny. Within a layer, deny beats allow regardless of order.',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  projectId: { type: 'string' },
                  rules: { type: 'array', items: permissionRuleSchema },
                  system: { type: 'array', items: permissionRuleSchema },
                  updatedAt: { type: 'string', format: 'date-time' },
                  updatedBy: { type: 'string' },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
      put: {
        summary: 'Replace the permission rules of a project. Administrators only',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { type: 'object', properties: { rules: { type: 'array', items: permissionRuleSchema, maxItems: 300 } }, required: ['rules'] } },
          },
        },
        responses: {
          '200': {
            description: 'Saved',
            ...json(envelope({ type: 'object', properties: { projectId: { type: 'string' }, rules: { type: 'array', items: permissionRuleSchema } } })),
          },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{projectId}/permissions/test': {
      post: {
        summary:
          'What would be decided for a request (nothing is recorded). A terminal command is analyzed like the terminal does: every part and every redirect. Administrators only',
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  agentId: { type: 'string' },
                  category: { type: 'string', enum: ['terminal', 'read', 'write', 'network', 'mcp', 'skill', 'delegate', 'account', 'repository', 'trigger'] },
                  value: { type: 'string' },
                },
                required: ['category', 'value'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'OK. `allowed` is true only if every part is allowed.',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  allowed: { type: 'boolean' },
                  parts: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        category: { type: 'string' },
                        value: { type: 'string' },
                        allowed: { type: 'boolean' },
                        layer: { type: 'string', enum: ['system', 'agent', 'project', 'default'] },
                        reason: { type: 'string' },
                      },
                    },
                  },
                },
              }),
            ),
          },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/projects/{projectId}/permissions/decisions': {
      get: {
        summary: 'The latest permission decisions taken in the project (at most 200; the last 500 are kept). Administrators only',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'agentId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    at: { type: 'string', format: 'date-time' },
                    agentId: { type: 'string' },
                    sessionId: { type: 'string' },
                    category: { type: 'string' },
                    subject: { type: 'string' },
                    allowed: { type: 'boolean' },
                    layer: { type: 'string' },
                    pattern: { type: 'string' },
                  },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
    },
    '/schedules': {
      get: {
        summary: 'Every schedule — or, with ?project=, those of the project agents plus those of global agents that run in it — ordered by the next run. Administrators only',
        parameters: [{ name: 'project', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: scheduleSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/agents/{agentId}/schedules': {
      get: {
        summary:
          'The schedules of an agent: it runs a text (as typed in the chat — /command args works) at the times of a cron expression, as the account that created it. Administrators only',
        parameters: [agentIdParam],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: scheduleSchema })) }, '401': failures['401'], '404': failures['404'] },
      },
      post: {
        summary: 'Create a schedule. It runs as you; at least 5 minutes between runs; pauses itself after 5 failures in a row. Administrators only',
        parameters: [agentIdParam],
        requestBody: { required: true, ...json(scheduleInput) },
        responses: { '201': { description: 'Created', ...json(envelope(scheduleSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/agents/{agentId}/schedules/{scheduleName}': {
      put: {
        summary: 'Change a schedule (the name stays). Turning it back on clears the failures. Administrators only',
        parameters: [agentIdParam, scheduleNameParam],
        requestBody: { required: true, ...json(scheduleInput) },
        responses: { '200': { description: 'OK', ...json(envelope(scheduleSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
      delete: {
        summary: 'Delete a schedule and its run history. Administrators only',
        parameters: [agentIdParam, scheduleNameParam],
        responses: { '200': { description: 'OK' }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/agents/{agentId}/schedules/{scheduleName}/run': {
      post: {
        summary: 'Run a schedule now, outside its times (it does not move the clock). Answers at once; the run history shows how it goes. Administrators only',
        parameters: [agentIdParam, scheduleNameParam],
        responses: { '202': { description: 'Started' }, '401': failures['401'], '404': failures['404'] },
      },
    },
    '/agents/{agentId}/schedules/{scheduleName}/runs': {
      get: {
        summary: 'The last 20 runs of a schedule: when, trigger (cron, manual), status (running, ok, error, skipped, missed) and the conversation. Administrators only',
        parameters: [agentIdParam, scheduleNameParam],
        responses: { '200': { description: 'OK', ...json(envelope({ type: 'array', items: scheduleRunSchema })) }, '401': failures['401'], '404': failures['404'] },
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
    '/turn-tools': {
      post: {
        summary:
          "The gateway's terminal, files and to-do list for a CLI lane (Codex), over MCP. Requires the turn grant in X-Turn-Grant: the tools and the context (agent, conversation, project) come from it, valid only while that turn runs. Every call goes through the agent's permissions and sandbox",
        parameters: [{ name: 'X-Turn-Grant', in: 'header', required: true, schema: { type: 'string' } }],
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
          'The gateway as an MCP server (Streamable HTTP, stateless, JSON responses): list_agents, start_conversation, send_message, get_turn (not offered to agents, which delegate with delegate_to_agent), switch_model, list_conversations, get_conversation, my_usage — plus, for administrators, usage_by_key, list_providers, list_models, list_tools, get_agent and — unless SELF_MCP_WRITE=0 — set_model_enabled, set_model_price and save_agent. Same credentials and rules as this API',
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
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_]{1,64}$' } }, ...usageByKeyParams],
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
          ...usageByKeyParams,
        ],
        responses: {
          '200': { description: 'OK', ...json(envelope(usageSummary(true))) },
          '401': failures['401'],
          '404': failures['404'],
          '422': { description: 'Invalid metadata key or period', ...json(failureEnvelope) },
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
      patch: {
        summary:
          'Change only some fields of an agent (the self MCP `patch_agent`), through the normal agent write path with the same rules as PUT; `null` removes a field. Whatever widens access (by the catalog widening detector: tools, delegation, permissions, exposure, scope, sandbox, environment) is NOT applied: it becomes a pending permission request that only an administrator signed in on the screen approves; the rest applies at once. Administrators only',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['patch', 'reason'],
            properties: {
              patch: { type: 'object', description: 'Fields of PUT /agents/{agentId} (no id or files), each with its new value.' },
              reason: { type: 'string', maxLength: 1000, description: 'Why: shown to the administrator who confirms.' },
            },
          }),
        },
        responses: {
          '200': {
            description: 'Non-widening fields applied; widening fields (if any) pending',
            ...json(
              envelope({
                type: 'object',
                properties: { agentId: { type: 'string' }, applied: { type: 'array', items: { type: 'string' } }, pending: permissionRequestSchema, notice: { type: 'string' } },
              }),
            ),
          },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
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
                  builderProvider: nullableText,
                  builderModel: nullableText,
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
          {
            name: 'mine',
            in: 'query',
            schema: { type: 'string', enum: ['1'] },
            description:
              '`scope=all` with `page`: only the caller conversations (the administrator inbox), with the same search and counts; `scope` comes back as `mine`. Without it, everyone (the monitor). The paginated list never includes archived or delegated conversations, and `total` counts what it lists.',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string', maxLength: 100 },
            description: 'Searches the title, the owner e-mail, id and account, and the conversation id (`gw_…`), case-insensitive for ASCII.',
          },
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
          'Events: `conversation.updated` with `{ session }` in the same projection as the listing (no `classification` or `costUsd` unless administrator), `conversation.deleted` with `{ sessionId }`, and `conversation.running` / `conversation.idle` with `{ sessionId }` when a turn starts or ends (on connect, one `conversation.running` per conversation already running), and `catalog.changed` with `{ changes: [{ kind, id, projectId?, op }] }` whenever a catalog item gets a new revision (any write path: screen, API, MCP, agent, import, rollback) — only global items and projects the caller belongs to, everything for an administrator. The first event, `stream.ready` with `{ streamId }`, names this stream for `PUT /conversations/events/{streamId}/follow`. A `: ping` comment every 15s keeps the connection open.',
        responses: { '200': { description: 'An event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } }, '401': failures['401'] },
      },
    },
    '/conversations/events/{streamId}/follow': {
      put: {
        summary: 'Follow the live turn of one conversation on an open `/conversations/events` stream (one connection per tab, not two). `null` stops',
        description:
          'The stream then also carries `turn.started`, `turn.event`, `turn.finished` (as in `/sessions/{id}/live`) with `sessionId`, and `turn.idle` when nothing is running as the follow starts. The stream must be the caller own, and the conversation theirs (or the caller an administrator); 404 otherwise.',
        parameters: [{ name: 'streamId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, ...json({ type: 'object', required: ['sessionId'], properties: { sessionId: { type: ['string', 'null'] } } }) },
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', properties: { following: { type: ['string', 'null'] } } })) },
          '401': failures['401'],
          '404': failures['404'],
          '422': failures['422'],
        },
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
    '/conversations/{id}/todos': {
      get: {
        summary: 'The task list of a conversation (kept by the agent with the `update_todos` tool). The owner or an administrator; anyone else gets 404',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK. Empty `items` = no task list yet.',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  sessionId: { type: 'string' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { title: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] } },
                      required: ['title', 'status'],
                    },
                  },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
                required: ['sessionId', 'items'],
              }),
            ),
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
                  repository: {
                    type: 'string',
                    description:
                      'A repository of the project (`<project>/repositories/<name>`). The agent works there: cwd, file tools and sandbox root. Needs the agent permission `repository <name>`. Fixed for the conversation.',
                  },
                  worktree: { type: 'string', description: 'A git worktree of that repository, by folder name or branch. Requires `repository`. The gateway does not create it.' },
                  callbackUrl: {
                    type: 'string',
                    format: 'uri',
                    description:
                      'Where the end of every turn started with `POST /sessions/{id}/turns` is POSTed (turns from `/messages` send nothing). Body: `{ conversationId, turn, status: ok | error | aborted, error?, usage?, durationMs, agentId, metadata, at }` — `metadata` is what this request declared, `at` the end time (ISO); the reply text is not in it (read `GET /sessions/{id}/turns/{turn}`). Signed with `X-Gateway-Signature: sha256=<HMAC-SHA256 of the raw body with the address secret>`. Up to 3 attempts (now, +1 s, +3 s), 10 s each, redirects not followed, any 2xx is delivered: treat `conversationId + turn` as idempotency key. The address must be registered in the conversation project (an account of kind `turn-callback`, one secret per address), or, as a fallback, be in `TURN_CALLBACK_HOSTS` with `TURN_CALLBACK_SECRET` set; else 422.',
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
    '/sessions/{id}/compact': {
      post: {
        summary:
          'Compact the context at the start of the next turn: the model summarizes the conversation, which restarts with the summary and the last turns. It also runs on its own when the context passes `compactAtPercent` of the model window. Lanes that compact themselves answer 422',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK', ...json(envelope(sessionSchema)) }, '401': failures['401'], '404': failures['404'], '422': failures['422'] },
      },
    },
    '/sessions/{id}/turns': {
      post: {
        summary:
          'Start a turn without waiting (202): the turn runs on the server with no client attached. One turn per conversation: 409 `session_busy` while one runs, unless `whileBusy: queue` (the text enters the running turn)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  whileBusy: {
                    type: 'string',
                    enum: ['reject', 'queue'],
                    description: 'With a turn running: `queue` puts the text in that turn (202) instead of 409 `session_busy`. Text only; up to 10 waiting (409 `queue_full`)',
                  },
                },
                required: ['message'],
              },
            },
          },
        },
        responses: {
          '202': {
            description: 'Started',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  conversationId: { type: 'string' },
                  turn: { type: 'integer' },
                  status: { type: 'string', enum: ['running', 'queued'] },
                  position: { type: 'integer' },
                },
              }),
            ),
          },
          '404': failures['404'],
          '409': { description: 'A turn is already running in this conversation' },
        },
      },
    },
    '/sessions/{id}/changes': {
      get: {
        summary:
          'What the agent changed, like an IDE: the files (status, +/-, binary, protected) and commits of a scope, or of one commit; with `file`, that file diff. Only for a conversation opened in a repository',
        description:
          'Scopes: `conversation` (since the commit the conversation started on, committed and not), `uncommitted` (vs HEAD), `branch` (vs the merge base with origin/HEAD, main, master or automation). Read-only git with no external diff, textconv or fsmonitor. Secrets (`.env`, keys) are listed without content.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['conversation', 'uncommitted', 'branch'] } },
          { name: 'commit', in: 'query', schema: { type: 'string' } },
          { name: 'file', in: 'query', schema: { type: 'string' }, description: 'A path from the files of the same scope' },
        ],
        responses: {
          '200': { description: 'OK', ...json(envelope({ type: 'object', additionalProperties: true })) },
          '404': failures['404'],
          '422': failures['422'],
        },
      },
    },
    '/sessions/{id}/live': {
      get: {
        summary: 'The turn of a conversation, live (SSE), whoever started it (screen, API, schedule, delegation). The owner or an administrator; anyone else gets 404',
        description:
          'On connect, the running turn if any: `turn.started` with `{ turn: { request, startedAt, events } }` (consecutive text pieces already joined). Then `turn.event` with `{ event }` (the same agent events as `/messages`, secrets masked) and `turn.finished` once the turn is recorded. The stream stays open for the next turn. Counts toward the same per-account stream cap as `/conversations/events`.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'An event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          '401': failures['401'],
          '404': failures['404'],
          '429': { description: '`rate_limited`: too many open event streams for this account', ...json(failureEnvelope) },
        },
      },
    },
    '/sessions/{id}/turns/{turn}': {
      get: {
        summary: 'The state of a turn: running (with the text so far) or finished (ok, error, aborted)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'turn', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(
              envelope({
                type: 'object',
                properties: {
                  conversationId: { type: 'string' },
                  turn: { type: 'integer' },
                  status: { type: 'string', enum: ['running', 'ok', 'error', 'aborted'] },
                  text: { type: 'string' },
                  tools: { type: 'array', items: { type: 'string' } },
                  error: { type: 'string' },
                  usage: { type: 'object', additionalProperties: true },
                  durationMs: { type: 'integer' },
                },
              }),
            ),
          },
          '404': failures['404'],
        },
      },
    },
    '/sessions/{id}/messages': {
      post: {
        summary: 'Run a turn. Accept decides the format: SSE stream or aggregated JSON',
        description:
          'With a turn running, 409 `session_busy`; with `whileBusy: queue`, 202 `{ queued: true, position }` and the text enters that turn: between a tool and the next model call where the lane allows it (chat lanes, Claude Agent SDK), else as one more round when the model finishes. The turn shows it as a `message.injected` event and records it in `interjections`. A stopped turn drops what is still waiting, with a warning.',
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
                  whileBusy: {
                    type: 'string',
                    enum: ['reject', 'queue'],
                    description: 'With a turn running: `queue` puts the text in that turn (202) instead of 409 `session_busy`. Text only; up to 10 waiting (409 `queue_full`)',
                  },
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
          '202': {
            description: 'Queued for the running turn (`whileBusy: queue`)',
            ...json(envelope({ type: 'object', properties: { queued: { type: 'boolean' }, position: { type: 'integer' } } })),
          },
          '401': failures['401'],
          '404': failures['404'],
          '409': { description: '`session_busy` (a turn is running) or `queue_full`', ...json(failureEnvelope) },
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
