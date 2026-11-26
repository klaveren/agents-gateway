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
import { execFileSync } from 'node:child_process'
import {
  ANTIGRAVITY_FOLLOW_UPS,
  AntigravityAgentAdapter,
  allowTurnTools,
  antigravityArgs,
  antigravityFailure,
  antigravityInput,
  ANTIGRAVITY_BASH_MAX_S,
  UNFINISHED_STEP_MESSAGE,
  turnToolsPluginDir,
  withToolDeadline,
  writeTurnToolsPlugin,
} from './AntigravityAgent.Adapter'
import { aggregateTurn } from '@application/Turn.Aggregator'

interface ISpawned {
  command: string
  args: string[]
  options: { cwd?: string; env?: Record<string, string> }
  /** O que o gateway escreveu na entrada padrão do CLI (o prompt). */
  input: string
}

/** Um `spawn` falso: devolve as linhas NDJSON do turno e fecha com o código dado. */
function fakeSpawn(calls: ISpawned[], lines: (turn: number) => string[], code = 0, stderr = '') {
  return ((command: string, args: string[], options: ISpawned['options']) => {
    const call: ISpawned = { command, args, options, input: '' }
    calls.push(call)
    const stdin = new PassThrough()
    stdin.on('data', (chunk: Buffer) => (call.input += chunk.toString()))
    const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: () => true })
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
  JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls /' } } },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: 'permission check failed\nmais' } } },
  }),
  JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: `oi ${n}` } }),
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
  it('⛔ sempre `--sandbox`, nunca `--dangerously-skip-permissions`; o prompt vai pela entrada, nunca como argumento', () => {
    const args = antigravityArgs('gemini-4-argon-high', 'conv-9')
    assert.deepStrictEqual(args.slice(0, 5), ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json'])
    assert.ok(args.includes('--sandbox'))
    assert.ok(args.includes('--disable-slash-commands'))
    assert.ok(!args.some((arg) => arg.includes('dangerously')))
    // A mensagem que parece flag é só conteúdo da linha JSON.
    assert.deepStrictEqual(JSON.parse(antigravityInput('--dangerously-skip-permissions /apaga tudo')), {
      event: 'user',
      message: { content: '--dangerously-skip-permissions /apaga tudo' },
    })
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
      const prompt = (call: ISpawned) => (JSON.parse(call.input) as { message: { content: string } }).message.content
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
      ['message.started', 'tool.started', 'tool.error', 'text.delta', 'usage', 'warning', 'message.completed'],
    )
    assert.deepStrictEqual(events.find((event) => event.type === 'tool.error')?.payload, { tool: 'run_command', message: 'permission check failed\nmais', callId: 'conv-1:1' })
    assert.deepStrictEqual(events.find((event) => event.type === 'usage')?.payload, { inputTokens: 50, cacheReadTokens: 10, outputTokens: 5, reasoningTokens: 2 })
  })

  it('📥 prompt acima dos 128 KiB do Linux roda: vai pela entrada padrão, inteiro, e nada dele nos argumentos', async () => {
    const calls: ISpawned[] = []
    const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn(calls, turn), home: () => '/gw' })
    const session = await adapter.createSession(agent, { environment: `## Specs do agente\n${'y'.repeat(100_000)}` })
    const events = await collect(adapter.sendMessage(agent, session.id, { text: 'z'.repeat(40_000) }, {}))
    assert.strictEqual(calls.length, 1)
    assert.ok(events.some((event) => event.type === 'message.completed'))
    const content = (JSON.parse(calls[0].input) as { message: { content: string } }).message.content
    assert.ok(Buffer.byteLength(content) > 131_071 && content.endsWith('z'.repeat(40_000)))
    assert.ok(calls[0].args.every((arg) => arg.length < 200))
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
    // ⛔ O arquivo do plugin é lido pelo agente: só a concessão do turno, nunca o token de quem conversa.
    assert.deepStrictEqual(Object.keys(during.headers ?? {}), ['X-Turn-Grant'])
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

  // O que a .4 gravou: o Gemini chama o `run_command` nativo, o sandbox do CLI nega (sem resultado do passo) e o turno acaba mudo.
  const deniedNative = [
    JSON.stringify({ event: 'init', conversation_id: 'conv-1' }),
    JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'git status' } } },
    }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } }),
  ]
  const answered = [
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Feito pelo run_bash.' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }),
  ]

  it('⚖️ turno que acaba mudo depois do terminal nativo negado: o gateway segue UMA vez, na mesma conversa, com o motivo', async () => {
    const calls: ISpawned[] = []
    const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn(calls, (n) => (n === 1 ? deniedNative : answered)), home: () => '/h' })
    const session = await adapter.createSession(agent, {})
    const events = await collect(adapter.sendMessage(agent, session.id, { text: 'rode git status' }, {}))

    assert.strictEqual(calls.length, 2)
    assert.deepStrictEqual(calls[1].args.slice(-2), ['--conversation', 'conv-1'])
    const followUp = (JSON.parse(calls[1].input) as { message: { content: string } }).message.content
    assert.match(followUp, /run_command: negado pelo sandbox do Antigravity \(RunCommand\)/)
    assert.match(followUp, /run_bash/)
    assert.strictEqual(events.filter((event) => event.type === 'message.completed').length, 1)
    assert.strictEqual(events.at(-1)?.type, 'message.completed')
    assert.ok(events.some((event) => event.type === 'text.delta' && event.payload.text === 'Feito pelo run_bash.'))
    assert.ok(events.some((event) => event.type === 'warning' && /seguiu o turno/.test(event.payload.message)))
  })

  it('⛔ o teto: falhou de novo depois da continuação, o turno acaba (sem laço)', async () => {
    const calls: ISpawned[] = []
    const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn(calls, () => deniedNative), home: () => '/h' })
    const session = await adapter.createSession(agent, {})
    const events = await collect(adapter.sendMessage(agent, session.id, { text: 'olá' }, {}))
    assert.strictEqual(calls.length, 1 + ANTIGRAVITY_FOLLOW_UPS)
    assert.strictEqual(events.at(-1)?.type, 'message.completed')
    // ⛔ Nunca vazio: o gateway fecha o turno com o que falhou, marcado como dele, antes do fim.
    const texts = events.filter((event) => event.type === 'text.delta')
    assert.strictEqual(texts.length, 1)
    assert.match(texts[0].payload.text, /^\[gateway\] .*Parou em `run_command`: negado pelo sandbox do Antigravity \(RunCommand\)\./)
    assert.strictEqual(events.at(-2), texts[0])
  })

  it('a continuação respondeu: nada de resumo do gateway', async () => {
    const calls: ISpawned[] = []
    const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn(calls, (n) => (n === 1 ? deniedNative : answered)), home: () => '/h' })
    const session = await adapter.createSession(agent, {})
    const events = await collect(adapter.sendMessage(agent, session.id, { text: 'olá' }, {}))
    assert.ok(!events.some((event) => event.type === 'text.delta' && event.payload.text.startsWith('[gateway]')))
  })

  it('ferramenta que falhou e o modelo respondeu depois: nada de continuação', async () => {
    const calls: ISpawned[] = []
    const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn(calls, turn), home: () => '/h' })
    const session = await adapter.createSession(agent, {})
    await collect(adapter.sendMessage(agent, session.id, { text: 'olá' }, {}))
    assert.strictEqual(calls.length, 1)
  })

  it('⛔ o plugin diz que o terminal é o do gateway e recusa o `run_command` nativo com o motivo (o gancho roda e decide)', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agy-ws-'))
    const dir = writeTurnToolsPlugin(workspace, 'http://x', { 'X-Turn-Grant': 'g' }, ['run_bash', 'read_file'])
    assert.match(readFileSync(join(dir, 'rules', 'AGENTS.md'), 'utf8'), /run_command\) está DESLIGADO.*run_bash do servidor gateway_tools/)
    const hooks = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as Record<string, { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }>
    const group = hooks['gateway-terminal'].PreToolUse[0]
    assert.strictEqual(group.matcher, 'run_command')
    const out = execFileSync('sh', ['-c', group.hooks[0].command], {
      input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: "echo 'x'" } } }),
      cwd: dir,
    }).toString()
    const decision = JSON.parse(out) as { decision: string; reason: string }
    assert.strictEqual(decision.decision, 'deny')
    assert.match(decision.reason, /run_bash/)
    const none = writeTurnToolsPlugin(mkdtempSync(join(tmpdir(), 'agy-ws-')), 'http://x', {}, ['read_file'])
    assert.match(readFileSync(join(none, 'rules', 'AGENTS.md'), 'utf8'), /não tem terminal/)
  })
  /** As linhas do `agy` 1.4.9 de verdade (26/11): o resultado em `tool_info.output`, um passo CANCELADO e um que ficou aberto. */
  const toolTurn = () => [
    JSON.stringify({ event: 'init', conversation_id: 'conv-7' }),
    ...[
      { step_index: 2, state: 'ACTIVE', tool: 'ls -la apps' },
      { step_index: 2, state: 'CANCELED', tool: 'ls -la apps' },
      { step_index: 4, state: 'ACTIVE', tool: 'pwd' },
      { step_index: 4, state: 'DONE', tool: 'pwd', output: '/repo/_worktrees/EP-1' },
      { step_index: 4, state: 'DONE', tool: 'pwd', output: '/repo/_worktrees/EP-1' },
      { step_index: 6, state: 'ACTIVE', tool: 'x --help' },
      { step_index: 6, state: 'ERROR', tool: 'x --help', error: "Exit code 1: ERRO uso: flag desconhecida '--help'\n→ FAÇA: …" },
      { step_index: 8, state: 'ACTIVE', tool: 'x --dry-run' },
    ].map(({ step_index, state, tool, output, error }) =>
      JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index,
          state,
          step_type: 'tool',
          tool_name: 'mcp_gateway_tools_run_bash',
          tool_info: {
            name: 'mcp_gateway_tools_run_bash',
            parameters: { command: tool },
            ...(output ? { output } : {}),
            ...(error ? { error: { type: 'TOOL_ERROR', message: error } } : {}),
          },
        },
      }),
    ),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }),
  ]

  it('⛔ cada resultado na SUA chamada (pelo passo): o cancelado e o que ficou aberto fecham com o motivo; o texto da ferramenta fica gravado', async () => {
    const adapter = new AntigravityAgentAdapter({ store: new SessionStore(), spawn: fakeSpawn([], toolTurn), home: () => '/h' })
    const session = await adapter.createSession(agent, {})
    const events = await collect(adapter.sendMessage(agent, session.id, { text: 'olá' }, {}))
    const all = aggregateTurn(session.id, events).toolCalls
    // A rodada parou numa ferramenta sem resultado: o gateway segue UMA vez (o `spawn` falso repete as mesmas linhas).
    assert.strictEqual(all.length, 8)
    const calls = all.slice(0, 4)
    assert.deepStrictEqual(
      calls.map((call) => [call.args.command, call.result ?? null, call.error ?? null]),
      [
        ['ls -la apps', null, 'interrompida: o Antigravity encerrou o passo antes do resultado'],
        ['pwd', '/repo/_worktrees/EP-1', null],
        ['x --help', null, "Exit code 1: ERRO uso: flag desconhecida '--help'\n→ FAÇA: …"],
        ['x --dry-run', null, UNFINISHED_STEP_MESSAGE],
      ],
    )
    // O resumo do turno mudo diz por que parou, com a primeira linha só.
    const summary = events
      .filter((event) => event.type === 'text.delta')
      .map((event) => event.payload.text)
      .join('')
    assert.match(summary, /Parou em `mcp_gateway_tools_run_bash`: sem resultado: o Antigravity encerrou a rodada/)
  })

  it('⏱️ a ferramenta sempre responde antes dos 3 min do agy: o run_bash longo é cortado com aviso, a que não volta vira erro com o motivo', async () => {
    let seen: Record<string, unknown> = {}
    const capped = await withToolDeadline('run_bash', { command: 'pnpm test', timeoutSeconds: 600 }, async (args) => ((seen = args), { status: 'success', result: 'ok' }))
    assert.strictEqual(seen.timeoutSeconds, ANTIGRAVITY_BASH_MAX_S)
    assert.match(capped.result, /^Aviso: o Antigravity espera no máximo 3 min.*\nok$/s)
    const kept = await withToolDeadline('run_bash', { command: 'ls', timeoutSeconds: 30 }, async (args) => ((seen = args), { status: 'success', result: 'ok' }))
    assert.deepStrictEqual([seen.timeoutSeconds, kept.result], [30, 'ok'])
    const late = await withToolDeadline('read_file', {}, () => new Promise(() => undefined), 20)
    assert.strictEqual(late.status, 'error')
    assert.match(late.result, /Sem resposta do gateway em 0s \(read_file\)/)
  })
})
