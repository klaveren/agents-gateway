import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { SessionStore } from '@infra/session/Session.Store'
import { TurnGrants } from '@infra/tools/Turn.Grants'
import { AntigravityAgentAdapter, allowTurnTools, antigravityArgs, antigravityFailure, turnToolsPluginDir } from './AntigravityAgent.Adapter'

interface ISpawned {
  command: string
  args: string[]
  options: { cwd?: string; env?: Record<string, string> }
}

/** Um `spawn` falso: devolve as linhas NDJSON do turno e fecha com o código dado. */
function fakeSpawn(calls: ISpawned[], lines: (turn: number) => string[], code = 0, stderr = '') {
  return ((command: string, args: string[], options: ISpawned['options']) => {
    calls.push({ command, args, options })
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: () => true })
    setImmediate(() => {
      for (const line of lines(calls.length)) child.stdout.write(`${line}\n`)
      if (stderr) child.stderr.write(stderr)
      child.stdout.end()
      child.stderr.end()
      child.exitCode = code
      setImmediate(() => child.emit('close', code))
    })
    return child
  }) as never
}

const agent: IAgent = {
  id: 'gema',
  name: 'Gema',
  providers: [{ provider: 'antigravity', models: ['gemini-3.8-flash-medium'] }],
  soul: 'Você é a Gema.',
  systemPrompt: 'Seja breve.',
  modes: [EMode.AGENT],
  allowedTools: [],
}

async function collect(stream: AsyncIterable<IAgentEvent>): Promise<IAgentEvent[]> {
  const out: IAgentEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

const turn = (n: number) => [
  JSON.stringify({ event: 'init', conversation_id: 'conv-1' }),
  JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: `oi ${n}` } }),
  JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls /' } } },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: 'permission check failed\nmais' } } },
  }),
  'linha que não é json',
  JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      usage: { input_tokens: 50, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 10 },
      denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
    },
  }),
]

describe('AntigravityAgentAdapter', () => {
  it('⛔ sempre `--sandbox`, nunca `--dangerously-skip-permissions`, e mensagem nunca vira comando do CLI', () => {
    const args = antigravityArgs('--dangerously-skip-permissions /apaga tudo', 'gemini-4-argon-high', 'conv-9')
    assert.strictEqual(args[0], '-p=--dangerously-skip-permissions /apaga tudo')
    assert.ok(args.includes('--sandbox'))
    assert.ok(args.includes('--disable-slash-commands'))
    assert.ok(!args.slice(1).some((arg) => arg.includes('dangerously')))
    assert.deepStrictEqual(args.slice(-4), ['--model', 'gemini-4-argon-high', '--conversation', 'conv-9'])
  })

  it('⛔ agente de projeto: o Gemini roda na pasta vazia da conversa, nunca na do projeto (ele lê tudo o que está nela)', async () => {
    const calls: ISpawned[] = []
    const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn(calls, turn), home: () => '/Users/pessoa' })
    const project = { ...agent, projectId: 'xpto' }
    const session = await adapter.createSession(project, {})
    await collect(adapter.sendMessage(project, session.id, { text: 'olá' }, {}))
    assert.ok(calls[0].options.cwd?.includes('gateway-sub') && !calls[0].options.cwd.includes('xpto'))
    assert.ok(calls[0].args.includes('--sandbox'))
  })

  it('primeiro turno leva as instruções; o segundo retoma a conversa, sem repeti-las; ambiente mínimo', async () => {
    const calls: ISpawned[] = []
    const previous = process.env.AUTH_SECRET
    process.env.AUTH_SECRET = 'segredo-do-gateway'
    try {
      const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn(calls, turn), home: () => '/Users/pessoa' })
      const session = await adapter.createSession(agent, {})
      await collect(adapter.sendMessage(agent, session.id, { text: 'olá' }, {}))
      await collect(adapter.sendMessage(agent, session.id, { text: 'e aí' }, {}))

      const [first, second] = calls
      const prompt = (call: ISpawned) => (call.args.find((arg) => arg.startsWith('-p=')) ?? '').slice(3)
      assert.ok(prompt(first).includes('Você é a Gema.') && prompt(first).endsWith('olá'))
      assert.strictEqual(prompt(second), 'e aí')
      assert.ok(!first.args.includes('--conversation'))
      assert.deepStrictEqual(second.args.slice(-2), ['--conversation', 'conv-1'])
      assert.strictEqual(first.options.env?.HOME, '/Users/pessoa')
      assert.ok(!JSON.stringify(first.options.env).includes('segredo-do-gateway'))
      assert.ok(first.options.cwd?.includes('gateway-sub'))
    } finally {
      if (previous === undefined) delete process.env.AUTH_SECRET
      else process.env.AUTH_SECRET = previous
    }
  })

  it('mapeia texto, ferramenta negada, uso e o aviso do sandbox', async () => {
    const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn([], turn), home: () => '/h' })
    const session = await adapter.createSession(agent, {})
    const events = await collect(adapter.sendMessage(agent, session.id, { text: 'olá' }, {}))

    assert.deepStrictEqual(
      events.map((event) => event.type),
      ['message.started', 'text.delta', 'tool.started', 'tool.error', 'usage', 'warning', 'message.completed'],
    )
    assert.deepStrictEqual(events.find((event) => event.type === 'tool.error')?.payload, { tool: 'run_command', message: 'permission check failed' })
    assert.deepStrictEqual(events.find((event) => event.type === 'usage')?.payload, { inputTokens: 50, cacheReadTokens: 10, outputTokens: 5, reasoningTokens: 2 })
  })

  it('sem resultado, o erro diz o que fazer quando é o login', async () => {
    const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn([], () => [], 1, 'Authentication required. Please visit'), home: () => '/h' })
    const session = await adapter.createSession(agent, {})
    const events = await collect(adapter.sendMessage(agent, session.id, { text: 'olá' }, {}))
    assert.strictEqual(events.at(-1)?.type, 'error')
    assert.match(JSON.stringify(events.at(-1)?.payload), /não está conectado/)
    assert.match(antigravityFailure('', null), /ANTIGRAVITY_BIN/)
  })

  it('⛔ as ferramentas do gateway e os MCPs do agente: plugin na pasta da conversa com o token do turno, que morre no fim', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-home-'))
    const grants = new TurnGrants()
    const invoked: string[] = []
    const tool = (name: string, origin: string) => ({ name, description: name, inputSchema: { type: 'object' }, origin })
    // A caixa do agente: as locais e as do MCP escolhido; a chamada passa pelo `invoke` dela (que confere as permissões).
    const catalog = {
      toolbox: async () => ({
        tools: [tool('run_bash', 'local'), tool('read_file', 'local'), tool('list_agents', 'mcp')],
        invoke: async (name: string) => (invoked.push(name), { status: 'success', result: 'ok' }),
      }),
    }
    let during: { url?: string; headers?: Record<string, string> } = {}
    let granted: unknown
    const calls: ISpawned[] = []
    const spawn = fakeSpawn(calls, (n) => {
      const config = JSON.parse(readFileSync(join(turnToolsPluginDir(calls[n - 1].options.cwd!), 'mcp_config.json'), 'utf8'))
      during = config.mcpServers.tools
      granted = grants.get(during.headers?.['X-Turn-Grant'])
      return turn(n)
    })
    const adapter = new AntigravityAgentAdapter({
      store: new SessionStore(),
      spawn,
      home: () => home,
      catalog: catalog as never,
      turnTools: { url: 'http://127.0.0.1:3000/v1/turn-tools', grants },
    })
    const session = await adapter.createSession(agent, {})
    await collect(adapter.sendMessage(agent, session.id, { text: 'olá' }, { token: 'tok-de-quem-conversa' }))

    assert.strictEqual(during.url, 'http://127.0.0.1:3000/v1/turn-tools')
    assert.strictEqual(during.headers?.['X-Tool-Authorization'], 'Bearer tok-de-quem-conversa')
    assert.deepStrictEqual(
      (granted as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
      ['run_bash', 'read_file', 'list_agents'],
    )
    await (granted as { tools: Array<{ execute: (args: object) => Promise<unknown> }> }).tools[2].execute({})
    assert.deepStrictEqual(invoked, ['list_agents'])
    assert.ok(!readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8').includes('list_agents'), 'um servidor só: o do gateway')
    assert.strictEqual(grants.get(during.headers?.['X-Turn-Grant']), undefined, 'acabou o turno, a concessão morre')
    assert.ok(!existsSync(turnToolsPluginDir(calls[0].options.cwd!)), 'e o plugin sai da pasta')
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'))
    assert.deepStrictEqual(settings.permissions.allow, ['mcp(gateway_tools/*)'])
  })

  it('⛔ a liberação só no HOME do gateway: mescla com o que existe, nunca no HOME da pessoa, nunca sobre um arquivo ilegível', () => {
    assert.strictEqual(allowTurnTools(homedir()), false)

    const home = mkdtempSync(join(tmpdir(), 'agy-home-'))
    const file = join(home, '.gemini', 'antigravity-cli', 'settings.json')
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(file, JSON.stringify({ queuedMessages: 'queue', permissions: { allow: ['read_file(*)'], deny: ['command(*)'] } }))
    assert.ok(allowTurnTools(home))
    assert.ok(allowTurnTools(home))
    assert.deepStrictEqual(JSON.parse(readFileSync(file, 'utf8')), {
      queuedMessages: 'queue',
      permissions: { allow: ['read_file(*)', 'mcp(gateway_tools/*)'], deny: ['command(*)'] },
    })

    writeFileSync(file, '{ // comentário\n}')
    assert.strictEqual(allowTurnTools(home), false)
    assert.strictEqual(readFileSync(file, 'utf8'), '{ // comentário\n}')
  })

  it('sem a liberação (HOME da pessoa), nada de plugin nem concessão, e o aviso diz', async () => {
    const grants = new TurnGrants()
    const register = grants.register.bind(grants)
    let registered = 0
    grants.register = (grant) => (registered++, register(grant))
    const calls: ISpawned[] = []
    const catalog = {
      toolbox: async () => ({ tools: [{ name: 'run_bash', description: '', inputSchema: {}, origin: 'local' }], invoke: async () => ({ status: 'success', result: '' }) }),
    }
    const adapter = new AntigravityAgentAdapter({
      store: new SessionStore(),
      spawn: fakeSpawn(calls, turn),
      home: () => homedir(),
      catalog: catalog as never,
      turnTools: { url: 'http://x', grants },
    })
    const session = await adapter.createSession(agent, {})
    const events = await collect(adapter.sendMessage(agent, session.id, { text: 'olá' }, {}))
    assert.strictEqual(registered, 0)
    assert.ok(!existsSync(turnToolsPluginDir(calls[0].options.cwd!)))
    assert.match(JSON.stringify(events.find((event) => event.type === 'warning')), /não chegam ao Antigravity/)
  })
})
