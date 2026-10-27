import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { fakeMcpRegistry, mcpTool } from '@infra/mcp/Mcp.Fake'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { CLAUDE_TEST_AGENT } from '../../testing/Agents.Fixture'
import { ILocalTool } from '@infra/tools/Tool.Types'
import { ClaudeAgentAdapter, cliEnv } from './ClaudeAgent.Adapter'

type TQuery = typeof query
type TQueryParams = Parameters<TQuery>[0]

const CLI_SESSION_ID = '11111111-2222-4333-8444-555555555555'

describe('ClaudeAgentAdapter', () => {
  const getAgent = (): IAgent => ({
    ...CLAUDE_TEST_AGENT,
    providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
    allowedTools: ['run_bash', 'mcp:crm/read_file'],
  })

  const turn = () => [
    { type: 'system', subtype: 'init', session_id: CLI_SESSION_ID },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Listing' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'run_bash', input: { command: 'ls' } }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      usage: { input_tokens: 12, output_tokens: 34 },
    },
  ]

  const queryWith = (messages: () => unknown[], seen: TQueryParams[] = []): TQuery =>
    ((params: TQueryParams) => {
      seen.push(params)
      return (async function* () {
        for (const message of messages()) yield message
      })()
    }) as unknown as TQuery

  const drain = async (events: AsyncIterable<IAgentEvent>): Promise<IAgentEvent[]> => {
    const collected: IAgentEvent[] = []
    for await (const event of events) collected.push(event)
    return collected
  }

  const localTool = (name: string): ILocalTool => ({
    origin: 'local',
    name,
    description: `local ${name}`,
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'cmd' } },
      required: ['command'],
      additionalProperties: false,
    },
    async execute() {
      return { status: 'success', result: 'ok' }
    },
  })

  const catalogWith = (connected: boolean) => new ToolCatalog(fakeMcpRegistry([{ id: 'crm', connected, tools: [mcpTool('read_file')] }]), [localTool('run_bash')])

  it('creates a session on the agent lane', async () => {
    const adapter = new ClaudeAgentAdapter({ query: queryWith(() => []) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })

    assert.ok(session.id.startsWith('claude-agent-'))
    assert.strictEqual(session.mode, EMode.AGENT)
  })

  it('translates the SDK message stream into gateway events', async () => {
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'list files' }, {}))

    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Listing'))
    assert.ok(events.find((e) => e.type === 'reasoning.delta' && e.payload.text === 'hmm'))
    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'run_bash' && e.payload.args.command === 'ls'))
    // O bloco de resultado só carrega o tool_use_id; o evento tem de sair com o nome,
    // senão o agregador não consegue casar chamada e resultado.
    assert.ok(events.find((e) => e.type === 'tool.result' && e.payload.tool === 'run_bash'))
    assert.ok(events.find((e) => e.type === 'usage' && e.payload.outputTokens === 34))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')
  })

  it('never runs a hand-rolled tool loop: no tools and no host settings leak in', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id, reasoning: 'high' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(seen[0].options?.tools, [])
    assert.deepStrictEqual(seen[0].options?.settingSources, [])
    assert.strictEqual(seen[0].options?.effort, 'high')
    assert.ok(seen[0].options?.abortController instanceof AbortController)
  })

  it('hands the key in effect to the CLI subprocess, read on every turn', async () => {
    const seen: TQueryParams[] = []
    let key = 'sk-ant-primeira'
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(turn, seen),
      connections: { connection: (id) => ({ providerId: id, name: 'Claude', protocol: EProvider.CLAUDE, key }) },
    })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
    key = 'sk-ant-segunda'
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.strictEqual(seen[0].options?.env?.ANTHROPIC_API_KEY, 'sk-ant-primeira')
    assert.strictEqual(seen[1].options?.env?.ANTHROPIC_API_KEY, 'sk-ant-segunda')
  })

  it('a compatible provider (OpenRouter) goes through ANTHROPIC_BASE_URL with the key as a bearer token, never as the Anthropic key', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(turn, seen),
      connections: { connection: (id) => ({ providerId: id, name: 'OpenRouter', protocol: EProvider.CLAUDE, baseUrl: 'https://openrouter.ai/api', key: 'sk-or-123' }) },
    })
    const session = await adapter.createSession({ ...getAgent(), providers: [{ provider: 'openrouter', models: ['claude-sonnet-5'] }] }, { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.strictEqual(seen[0].options?.env?.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
    assert.strictEqual(seen[0].options?.env?.ANTHROPIC_AUTH_TOKEN, 'sk-or-123')
    assert.strictEqual(seen[0].options?.env?.ANTHROPIC_API_KEY, '')
  })

  it('without any key, the turn ends with an error that says where to fix it — and the CLI never starts', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), connections: { connection: (id) => ({ providerId: id, name: 'Claude', protocol: EProvider.CLAUDE }) } })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.strictEqual(seen.length, 0)
    assert.ok(events.find((event) => event.type === 'error' && String(event.payload.message).includes('Providers')))
  })

  it('liga só as nativas do agente no CLI, o gate as aprova, e avisa quando o init não traz uma delas', async () => {
    const seen: TQueryParams[] = []
    const init = { type: 'system', subtype: 'init', session_id: 'cli-1', tools: ['WebSearch'] }
    const adapter = new ClaudeAgentAdapter({ query: queryWith(() => [init, ...turn()], seen) })
    const agent = { ...getAgent(), allowedTools: ['sdk:WebSearch', 'sdk:TodoWrite'] }
    const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))

    // `sdk:TodoWrite` vai ao CLI com os nomes de hoje (o 2.1.28x trocou TodoWrite por Task*).
    assert.deepStrictEqual(seen[0].options?.tools, ['WebSearch', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'])
    const gate = seen[0].options?.canUseTool as (name: string, input: Record<string, unknown>, options: unknown) => Promise<{ behavior: string }>
    assert.strictEqual((await gate('WebSearch', {}, {})).behavior, 'allow')
    assert.strictEqual((await gate('TaskCreate', {}, {})).behavior, 'allow')
    assert.strictEqual((await gate('Bash', {}, {})).behavior, 'deny')
    assert.ok(events.find((event) => event.type === 'warning' && String(event.payload.message).includes('TaskCreate')))
  })

  it('⛔ o CLI não carrega os conectores da conta claude.ai de quem fez o login', () => {
    assert.strictEqual(cliEnv({ key: 'k', compatible: false }).ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
  })

  it('sem nativas, nenhum built-in: tools continua vazio', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(seen[0].options?.tools, [])
  })

  it('plants a uuid on the first turn and resumes the CLI session afterwards', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'first' }, {}))
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'second' }, {}))

    // Turno 1: id nosso, em UUID limpo — o SDK recusa qualquer outro formato.
    const planted = seen[0].options?.sessionId
    assert.match(String(planted), /^[0-9a-f-]{36}$/)
    assert.strictEqual(seen[0].options?.resume, undefined)

    // Turno 2: retoma o id que o CLI reportou, não o id do gateway.
    assert.strictEqual(seen[1].options?.resume, CLI_SESSION_ID)
    assert.strictEqual(seen[1].options?.sessionId, undefined)
  })

  it('switches to streaming input when there are attachments', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'plain' }, {}))
    await drain(
      adapter.sendMessage(
        getAgent(),
        session.id,
        {
          text: 'look',
          files: [{ name: 'a.png', mimeType: 'image/png', data: 'aaa' }],
        },
        {},
      ),
    )

    assert.strictEqual(typeof seen[0].prompt, 'string')
    assert.strictEqual(typeof seen[1].prompt, 'object')
  })

  it('hands tools to the SDK as MCP servers, local and remote', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    const servers = seen[0].options?.mcpServers ?? {}
    assert.deepStrictEqual(Object.keys(servers).sort(), ['gateway', 'mcp_crm'])
    // Built-ins seguem desligados: o agente não ganha Bash/Read sobre a máquina do host.
    assert.deepStrictEqual(seen[0].options?.tools, [])
  })

  it('omits the remote server when no MCP is connected', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(false) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(Object.keys(seen[0].options?.mcpServers ?? {}), ['gateway'])
  })

  it('gates tool use through canUseTool instead of allowedTools', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    const gate = seen[0].options?.canUseTool
    assert.ok(gate)
    // `allowedTools` com nome solto sombrearia o callback, então tem de ficar ausente.
    assert.strictEqual(seen[0].options?.allowedTools, undefined)

    const options = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
    assert.strictEqual((await gate('mcp__gateway__run_bash', {}, options))?.behavior, 'allow')
    assert.strictEqual((await gate('mcp__mcp_crm__read_file', {}, options))?.behavior, 'allow')
    // ⛔ Do servidor escolhido, só a ferramenta escolhida; de servidor que o agente não tem, nada.
    assert.strictEqual((await gate('mcp__mcp_crm__delete_all', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('mcp__mcp_outro__read_file', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('Bash', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('mcp__gateway__search_web', {}, options))?.behavior, 'deny')
  })

  it('libera a delegate_to_agent de quem pode delegar (ela vem de agent:<id>, não de um nome)', async () => {
    const seen: TQueryParams[] = []
    const catalog = new ToolCatalog(fakeMcpRegistry(), [localTool('run_bash')], () => localTool('delegate_to_agent'))
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog })
    const agent = { ...getAgent(), allowedTools: ['agent:tradutor'] }
    const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))

    const gate = seen[0].options?.canUseTool
    const options = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
    assert.strictEqual((await gate!('mcp__gateway__delegate_to_agent', {}, options))?.behavior, 'allow')
    assert.strictEqual((await gate!('mcp__gateway__run_bash', {}, options))?.behavior, 'deny')
  })

  it('reports an error result from the SDK', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'], usage: {} }]),
    })

    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
    const error = events.find((e) => e.type === 'error')

    assert.ok(error && error.type === 'error')
    assert.strictEqual(error.payload.message, 'too many turns')
  })

  it('reports an aborted turn instead of an error', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: ((params: TQueryParams) =>
        (async function* () {
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } }
          if (params.options?.abortController?.signal.aborted) throw new Error('aborted')
          yield { type: 'result', subtype: 'success', is_error: false, result: '', usage: {} }
        })()) as unknown as TQuery,
    })

    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {})) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })

  it('counts the cache in the input and reports its parcels', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 190, output_tokens: 7 },
        },
      ]),
    })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(events.find((e) => e.type === 'usage')?.payload, { inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 190, outputTokens: 7 })
  })

  it('⚖️ o contexto em uso é a entrada da ÚLTIMA chamada do turno, não a soma que o `result` traz', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [
        {
          type: 'assistant',
          message: {
            usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 20 },
            content: [{ type: 'tool_use', id: 't1', name: 'run_bash', input: {} }],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        {
          type: 'assistant',
          message: { usage: { input_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 25, output_tokens: 9 }, content: [{ type: 'text', text: 'pronto' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'pronto',
          usage: { input_tokens: 45, cache_read_input_tokens: 2000, cache_creation_input_tokens: 25, output_tokens: 29 },
        },
      ]),
    })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))
    const usage = events.find((e) => e.type === 'usage')?.payload as { inputTokens: number; contextTokens: number }
    assert.deepStrictEqual([usage.inputTokens, usage.contextTokens], [2070, 1065])
  })

  it('emits the tool name without the SDK mcp prefix, and keeps it on the result', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__mcp__crm__stats', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      ]),
    })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'crm__stats'))
    assert.ok(events.find((e) => e.type === 'tool.result' && e.payload.tool === 'crm__stats'))
  })

  it('sends an attachment with no text without an empty text block', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })

    await drain(adapter.sendMessage(getAgent(), session.id, { text: '', files: [{ name: 'a.png', mimeType: 'image/png', data: 'aaa' }] }, {}))

    const prompts: Array<{ message: { content: Array<{ type: string }> } }> = []
    for await (const message of seen[0].prompt as AsyncIterable<{ message: { content: Array<{ type: string }> } }>) prompts.push(message)

    assert.deepStrictEqual(
      prompts[0].message.content.map((block) => block.type),
      ['image'],
    )
  })

  describe('agente de projeto: o cerco', () => {
    // A pasta do projeto nasce na pasta de dados (a do banco): aqui, uma temporária, e não a raiz do repo.
    const dataRoot = mkdtempSync(join(tmpdir(), 'gw-claude-project-'))
    const previousDb = process.env.CONVERSATIONS_DB
    before(() => (process.env.CONVERSATIONS_DB = join(dataRoot, 'gateway.db')))
    after(() => {
      process.env.CONVERSATIONS_DB = previousDb
      rmSync(dataRoot, { recursive: true, force: true })
    })
    const projectAgent = (): IAgent => ({ ...getAgent(), projectId: 'xpto', allowedTools: ['sdk:Bash', 'sdk:Read', 'sdk:Write'] })
    const options = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
    const sandbox = (available: boolean) => ({
      calls: [] as string[],
      async status() {
        return available
          ? { available: true, mechanism: 'seatbelt' as const }
          : { available: false, mechanism: 'bubblewrap' as const, reason: 'bwrap: No permissions to create new namespace' }
      },
      async wrap(command: string) {
        this.calls.push(command)
        if (!available) throw new Error('cerco indisponível neste servidor: bwrap: No permissions to create new namespace')
        return `cercado(${command})`
      },
    })
    const run = async (available: boolean) => {
      const seen: TQueryParams[] = []
      const fake = sandbox(available)
      const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true), sandbox: fake })
      const session = await adapter.createSession(projectAgent(), { agentId: CLAUDE_TEST_AGENT.id })
      await drain(adapter.sendMessage(projectAgent(), session.id, { text: 'oi' }, {}))
      return { options: seen[0].options!, fake }
    }

    it('⛔ o Bash sai embrulhado no cerco — uma vez só, mesmo passando pelo hook e pelo canUseTool', async () => {
      const { options: sent, fake } = await run(true)
      const gate = sent.canUseTool!
      const first = (await gate('Bash', { command: 'ls /', description: 'x' }, options)) as { behavior: string; updatedInput?: { command: string; description: string } }
      assert.deepStrictEqual([first.behavior, first.updatedInput?.command, first.updatedInput?.description], ['allow', 'cercado(ls /)', 'x'])
      const again = (await gate('Bash', { command: 'cercado(ls /)' }, options)) as { behavior: string; updatedInput?: unknown }
      assert.deepStrictEqual([again.behavior, again.updatedInput], ['allow', undefined])
      assert.deepStrictEqual(fake.calls, ['ls /'])

      const hook = sent.hooks?.PreToolUse?.[0]?.hooks?.[0]
      assert.ok(hook, 'o agente de projeto ganha o PreToolUse')
      const output = (await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 't2' } as never, 't2', {
        signal: options.signal,
      })) as {
        hookSpecificOutput: { permissionDecision: string; updatedInput?: { command: string } }
      }
      assert.deepStrictEqual([output.hookSpecificOutput.permissionDecision, output.hookSpecificOutput.updatedInput?.command], ['allow', 'cercado(pwd)'])
    })

    it('⛔ sem cerco, o Bash do projeto é recusado com o motivo; Read fora da pasta também', async () => {
      const { options: sent } = await run(false)
      const denied = (await sent.canUseTool!('Bash', { command: 'ls' }, options)) as { behavior: string; message?: string }
      assert.strictEqual(denied.behavior, 'deny')
      assert.match(denied.message ?? '', /No permissions to create new namespace.*bloqueado/)
      const outside = (await sent.canUseTool!('Read', { file_path: '/etc/hosts' }, options)) as { behavior: string; message?: string }
      assert.deepStrictEqual([outside.behavior, /fora da pasta do projeto/.test(outside.message ?? '')], ['deny', true])
      const inside = (await sent.canUseTool!('Write', { file_path: 'notas.md', content: 'x' }, options)) as { behavior: string }
      assert.strictEqual(inside.behavior, 'allow')
    })

    it('o agente global continua sem cerco nem hook', async () => {
      const seen: TQueryParams[] = []
      const fake = sandbox(true)
      const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true), sandbox: fake })
      const global = { ...getAgent(), allowedTools: ['sdk:Bash'] }
      const session = await adapter.createSession(global, { agentId: CLAUDE_TEST_AGENT.id })
      await drain(adapter.sendMessage(global, session.id, { text: 'oi' }, {}))
      assert.strictEqual(seen[0].options?.hooks, undefined)
      const decision = (await seen[0].options!.canUseTool!('Bash', { command: 'ls' }, options)) as { behavior: string; updatedInput?: unknown }
      assert.deepStrictEqual([decision.behavior, decision.updatedInput, fake.calls], ['allow', undefined, []])
    })
  })
})

describe('ClaudeAgentAdapter — a memória do CLI na retomada', () => {
  const SDK_ID = '11111111-2222-4333-8444-555555555555'
  const agent: IAgent = { ...CLAUDE_TEST_AGENT, providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }], allowedTools: [] }
  const queryWith = (seen: TQueryParams[]): TQuery =>
    ((params: TQueryParams) => {
      seen.push(params)
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: SDK_ID }
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
      })()
    }) as unknown as TQuery
  let dir = ''
  let previous: string | undefined
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-claude-cli-'))
    previous = process.env.CONVERSATIONS_DB
    process.env.CONVERSATIONS_DB = join(dir, 'gateway.db')
  })
  after(() => {
    if (previous === undefined) delete process.env.CONVERSATIONS_DB
    else process.env.CONVERSATIONS_DB = previous
    rmSync(dir, { recursive: true, force: true })
  })

  it('o CLI guarda as conversas no volume de dados (CLAUDE_CONFIG_DIR), não no HOME de quem roda', () => {
    assert.strictEqual(cliEnv({ key: 'k', compatible: false }).CLAUDE_CONFIG_DIR, join(dir, 'claude-cli'))
  })

  it('exporta o id do CLI só depois que ele começou', async () => {
    const adapter = new ClaudeAgentAdapter({ query: queryWith([]) })
    const session = await adapter.createSession(agent, { agentId: agent.id })
    assert.strictEqual(adapter.exportNative(session.id), undefined)
    for await (const _event of adapter.sendMessage(agent, session.id, { text: 'oi' }, {})) void _event
    assert.deepStrictEqual(adapter.exportNative(session.id), { sdkSessionId: SDK_ID })
  })

  it('⚖️ planta o id só se o CLI ainda tem a conversa; aí o próximo turno a reabre com `resume`', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(seen) })
    const session = await adapter.createSession(agent, { agentId: agent.id })
    assert.strictEqual(adapter.restoreNative(session.id, { sdkSessionId: SDK_ID }), false, 'sem o arquivo do CLI, vale a transcrição')
    assert.strictEqual(adapter.restoreNative(session.id, { sdkSessionId: '../../etc/passwd' }), false)

    mkdirSync(join(dir, 'claude-cli', 'projects', '-qualquer-pasta'), { recursive: true })
    writeFileSync(join(dir, 'claude-cli', 'projects', '-qualquer-pasta', `${SDK_ID}.jsonl`), '{}\n')
    assert.strictEqual(adapter.restoreNative(session.id, { sdkSessionId: SDK_ID }), true)

    for await (const _event of adapter.sendMessage(agent, session.id, { text: 'continua' }, {})) void _event
    assert.strictEqual(seen[0].options?.resume, SDK_ID)
  })
})
