import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { SessionStore } from '@infra/session/Session.Store'
import { AntigravityAgentAdapter, antigravityArgs, antigravityFailure } from './AntigravityAgent.Adapter'

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
  provider: 'antigravity',
  soul: 'Você é a Gema.',
  systemPrompt: 'Seja breve.',
  models: ['gemini-3.8-flash-medium'],
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
})
