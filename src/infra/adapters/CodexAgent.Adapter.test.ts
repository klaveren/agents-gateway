import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { CodexOptions, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import { EMode } from '@domain/enums/EMode.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { SessionStore } from '@infra/session/Session.Store'
import { TurnGrants } from '@infra/tools/Turn.Grants'
import { CODEX_LOCKED_FEATURES, CodexAgentAdapter, codexEvents, codexMcpServers, withMcpHint } from './CodexAgent.Adapter'

interface ICall {
  options: CodexOptions
  thread: ThreadOptions
  resumed?: string
  input: unknown
}

function fakeCodex(calls: ICall[], events: (turn: number) => ThreadEvent[]) {
  return class {
    constructor(private readonly options: CodexOptions) {}
    startThread(thread: ThreadOptions) {
      return this.thread(thread)
    }
    resumeThread(id: string, thread: ThreadOptions) {
      return this.thread(thread, id)
    }
    private thread(thread: ThreadOptions, resumed?: string) {
      const options = this.options
      return {
        async runStreamed(input: unknown) {
          calls.push({ options, thread, resumed, input })
          const turn = calls.length
          return {
            events: (async function* () {
              yield* events(turn)
            })(),
          }
        },
      }
    }
  }
}

const agent: IAgent = { id: 'cx', name: 'Cx', providers: [{ provider: 'codex', models: ['gpt-6.1-sol'] }], systemPrompt: 'Seja breve.', modes: [EMode.AGENT], allowedTools: [] }

async function collect(stream: AsyncIterable<IAgentEvent>): Promise<IAgentEvent[]> {
  const out: IAgentEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

describe('CodexAgentAdapter', () => {
  const turnEvents = (turn: number): ThreadEvent[] => [
    ...(turn === 1 ? [{ type: 'thread.started', thread_id: 'th-1' } as ThreadEvent] : []),
    { type: 'item.completed', item: { id: 'e', type: 'error', message: 'Code Mode aviso' } },
    { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: `resposta ${turn}` } },
    { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'fim' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 3 } },
  ]

  it('⛔ trava o Codex: sandbox read-only, sem aprovação, sem rede, features perigosas desligadas, HOME e CODEX_HOME do gateway, sem o .env', async () => {
    const calls: ICall[] = []
    const previous = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-nao-pode-vazar'
    try {
      const adapter = new CodexAgentAdapter({ store: new SessionStore(), load: async () => fakeCodex(calls, turnEvents) as never, home: () => '/gw/codex-home' })
      const session = await adapter.createSession(agent, { model: 'gpt-6.1-sol', reasoning: 'high' })
      await collect(adapter.sendMessage(agent, session.id, { text: 'oi' }, {}))

      const [call] = calls
      assert.strictEqual(call.thread.sandboxMode, 'read-only')
      assert.strictEqual(call.thread.approvalPolicy, 'never')
      assert.strictEqual(call.thread.networkAccessEnabled, false)
      assert.strictEqual(call.thread.webSearchMode, 'disabled')
      assert.strictEqual(call.thread.modelReasoningEffort, 'high')
      assert.strictEqual(call.options.env?.CODEX_HOME, '/gw/codex-home')
      assert.strictEqual(call.options.env?.HOME, call.thread.workingDirectory)
      assert.ok(!JSON.stringify(call.options.env).includes('nao-pode-vazar'))
      const config = call.options.config as { features: Record<string, boolean>; developer_instructions: string; cli_auth_credentials_store: string }
      assert.deepStrictEqual(config.features, { ...CODEX_LOCKED_FEATURES })
      assert.strictEqual(config.features.shell_tool, false)
      assert.strictEqual(config.cli_auth_credentials_store, 'file')
      assert.strictEqual(config.developer_instructions.includes('Seja breve.'), true)
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previous
    }
  })

  it('⛔ sempre só leitura, sem rede e sem o terminal do Codex, mesmo com o nível, a rede e a nativa escolhidos', async () => {
    const calls: ICall[] = []
    const open: IAgent = {
      ...agent,
      providers: agent.providers.map((target) => ({ ...target, sandbox: 'workspace-write' as const, network: true })),
      allowedTools: ['sdk:codex:shell'],
    }
    const adapter = new CodexAgentAdapter({ store: new SessionStore(), load: async () => fakeCodex(calls, turnEvents) as never, home: () => '/gw' })
    const session = await adapter.createSession(open, {})
    await collect(adapter.sendMessage(open, session.id, { text: 'oi' }, {}))

    const [call] = calls
    assert.strictEqual(call.thread.sandboxMode, 'read-only')
    assert.strictEqual(call.thread.networkAccessEnabled, false)
    const { features } = call.options.config as { features: Record<string, boolean> }
    assert.deepStrictEqual(features, CODEX_LOCKED_FEATURES)
  })

  it('⛔ o terminal e os arquivos do gateway por MCP, numa concessão que só vale durante o turno', async () => {
    const calls: ICall[] = []
    const grants = new TurnGrants()
    const local = (name: string) => ({
      origin: 'local' as const,
      name,
      description: name,
      inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const },
      execute: async () => ({ status: 'success' as const, result: name }),
    })
    const catalog = { localFor: () => [local('run_bash'), local('read_file')], mcpServersFor: async () => [] }
    let during: unknown
    const adapter = new CodexAgentAdapter({
      store: new SessionStore(),
      catalog: catalog as never,
      turnTools: { url: 'http://127.0.0.1:3000/v1/turn-tools', grants },
      load: async () =>
        fakeCodex(calls, (turn) => {
          const servers = (calls[turn - 1].options.config as { mcp_servers: Record<string, { http_headers: Record<string, string> }> }).mcp_servers
          during = grants.get(servers.gateway_tools.http_headers['X-Turn-Grant'])
          return turnEvents(turn)
        }) as never,
      home: () => '/gw',
    })
    const withTools: IAgent = { ...agent, allowedTools: ['run_bash', 'read_file'] }
    const session = await adapter.createSession(withTools, {})
    await collect(adapter.sendMessage(withTools, session.id, { text: 'oi' }, { token: 'tk', agentId: 'cx' }))

    const config = calls[0].options.config as { mcp_servers: Record<string, { url: string; http_headers: Record<string, string> }>; developer_instructions: string }
    const server = config.mcp_servers.gateway_tools
    assert.strictEqual(server.url, 'http://127.0.0.1:3000/v1/turn-tools')
    assert.strictEqual(server.http_headers['X-Tool-Authorization'], 'Bearer tk')
    assert.strictEqual((server as { default_tools_approval_mode?: string }).default_tools_approval_mode, 'approve')
    const granted = during as { tools: Array<{ name: string }>; context: { agentId: string; sessionId: string } }
    assert.deepStrictEqual([granted.tools.map((tool) => tool.name), granted.context.agentId, granted.context.sessionId], [['run_bash', 'read_file'], 'cx', session.id])
    assert.strictEqual(grants.get(server.http_headers['X-Turn-Grant']), undefined, 'acabou o turno, a concessão morre')
    assert.match(config.developer_instructions, /gateway_tools.*run_bash, read_file/)
  })

  it('retoma a thread no segundo turno e mapeia texto, uso (cache como parcela) e aviso não fatal', async () => {
    const calls: ICall[] = []
    const adapter = new CodexAgentAdapter({ store: new SessionStore(), load: async () => fakeCodex(calls, turnEvents) as never, home: () => '/gw' })
    const session = await adapter.createSession(agent, {})
    const first = await collect(adapter.sendMessage(agent, session.id, { text: 'um' }, {}))
    await collect(adapter.sendMessage(agent, session.id, { text: 'dois' }, {}))

    assert.deepStrictEqual(
      calls.map((call) => call.resumed),
      [undefined, 'th-1'],
    )
    assert.deepStrictEqual(
      first.map((event) => event.type),
      ['message.started', 'warning', 'text.delta', 'text.delta', 'usage', 'message.completed'],
    )
    assert.deepStrictEqual(
      first.filter((event) => event.type === 'text.delta').map((event) => event.payload),
      [{ text: 'resposta 1' }, { text: '\n\nfim' }],
    )
    assert.deepStrictEqual(first.find((event) => event.type === 'usage')?.payload, {
      inputTokens: 100,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 7,
      reasoningTokens: 3,
    })
  })

  it('turno que falha vira erro', async () => {
    const adapter = new CodexAgentAdapter({
      store: new SessionStore(),
      load: async () => fakeCodex([], () => [{ type: 'turn.failed', error: { message: 'não autenticado' } }]) as never,
      home: () => '/gw',
    })
    const session = await adapter.createSession(agent, {})
    const events = await collect(adapter.sendMessage(agent, session.id, { text: 'oi' }, {}))
    assert.deepStrictEqual(events.at(-1), { type: 'error', sessionId: session.id, timestamp: events.at(-1)?.timestamp, payload: { message: 'não autenticado' } })
  })

  it('os MCPs do agente viram `mcp_servers`, com a credencial de quem conversa e o filtro de ferramentas', () => {
    const servers = codexMcpServers(
      [
        { config: { id: 'gateway', url: 'http://127.0.0.1:3100/v1/mcp', auth: 'caller' } as never, tools: ['list_agents'], callerHeader: 'X-Tool-Authorization' },
        { config: { id: 'docs', url: 'http://docs/mcp', auth: 'none' } as never },
      ],
      'tok',
    )
    assert.deepStrictEqual(servers, {
      gateway: { url: 'http://127.0.0.1:3100/v1/mcp', http_headers: { 'X-Tool-Authorization': 'Bearer tok' }, enabled_tools: ['list_agents'] },
      docs: { url: 'http://docs/mcp' },
    })
  })

  it('o id da sessão carrega o protocolo', async () => {
    const session = await new CodexAgentAdapter({ store: new SessionStore() }).createSession(agent, {})
    assert.ok(session.id.startsWith('gw_'))
  })

  it('as instruções dizem quais ferramentas vêm do MCP (o Codex tem internas de mesmo nome)', () => {
    assert.strictEqual(withMcpHint('base', []), 'base')
    const hinted = withMcpHint('base', [{ config: { id: 'gateway' } as never, tools: ['list_agents'] }])
    assert.match(hinted, /servidor MCP `gateway`: list_agents/)
  })

  it('⛔ a chamada de MCP recusada vira erro na tela (o Codex manda `failed` com o motivo em `result`)', () => {
    const call = (status: string, text: string) =>
      codexEvents(
        {
          type: 'item.completed',
          item: {
            id: 'i',
            type: 'mcp_tool_call',
            server: 'gateway_tools',
            tool: 'run_bash',
            arguments: {},
            result: { content: [{ type: 'text', text }], structured_content: null },
            status,
          },
        } as never,
        's',
        {},
      )
    const [denied] = call('failed', 'Not permitted: negado')
    assert.deepStrictEqual([denied.type, denied.payload], ['tool.error', { tool: 'run_bash', message: 'Not permitted: negado' }])
    assert.strictEqual(call('completed', 'Linux')[0].type, 'tool.result')
  })
})
