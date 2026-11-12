import assert from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { decide, type IPermissionRule } from '@domain/Permission.Policy'
import type { IPermissionChecker } from '@application/Permissions.Service'
import { join } from 'node:path'
import { dataDir } from '@infra/adapters/support/Subscription.Workspace'
import { after, before, describe, it } from 'node:test'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import type { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { fakeMcpRegistry, mcpTool } from '@infra/mcp/Mcp.Fake'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { CLAUDE_TEST_AGENT } from '../../testing/Agents.Fixture'
import { ILocalTool } from '@infra/tools/Tool.Types'
import { LoopGuard } from '@infra/tools/Loop.Guard'
import { CLAUDE_TOOL_NAMES, ClaudeAgentAdapter, cliEnv, preToolUse, windowOf } from './ClaudeAgent.Adapter'
import { SessionStore } from '@infra/session/Session.Store'

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

  it('⚖️ o gateway compacta o Claude (gatilho e botão): a compactação do SDK, só no fim da janela, fica de rede', () => {
    const adapter: IAgentAdapter = new ClaudeAgentAdapter({ query: queryWith(() => []) })
    assert.ok(!adapter.compactsItself)
  })

  it('creates a session on the agent lane', async () => {
    const adapter = new ClaudeAgentAdapter({ query: queryWith(() => []) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })

    assert.ok(session.id.startsWith('gw_'))
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

  it('⛔ as nativas de arquivo nunca tocam .env nem chaves, também no agente global', async () => {
    const seen: TQueryParams[] = []
    const init = { type: 'system', subtype: 'init', session_id: 'cli-1', tools: ['Read', 'Write'] }
    const adapter = new ClaudeAgentAdapter({ query: queryWith(() => [init, ...turn()], seen) })
    const agent = { ...getAgent(), allowedTools: ['sdk:Read', 'sdk:Write'] }
    const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))

    const gate = seen[0].options?.canUseTool as (name: string, input: Record<string, unknown>, options: unknown) => Promise<{ behavior: string; message?: string }>
    assert.strictEqual((await gate('Read', { file_path: '/srv/app/notas.md' }, {})).behavior, 'allow')
    for (const file_path of ['/srv/app/.env', '/srv/app/.env.local', '/home/x/id_rsa', '/srv/certs/server.pem']) {
      const result = await gate('Read', { file_path }, {})
      assert.strictEqual(result.behavior, 'deny', file_path)
      assert.match(result.message ?? '', /protegido/)
    }
    assert.strictEqual((await gate('Write', { file_path: 'secrets.json' }, {})).behavior, 'deny')
  })

  it('⛔ a pasta privada nas nativas: a própria pela capacidade (sem regra), a de outro agente nunca', async () => {
    const seen: TQueryParams[] = []
    const init = { type: 'system', subtype: 'init', session_id: 'cli-1', tools: ['Read', 'Write', 'Glob'] }
    const data = dataDir()
    const mine = join(data, 'global', 'agents', CLAUDE_TEST_AGENT.id)
    // Nenhuma regra libera nada: só a pasta própria passa.
    const permissions = { check: () => ({ allowed: false, layer: 'default' as const, reason: 'sem regra' }) }
    const run = async (write: boolean) => {
      const adapter = new ClaudeAgentAdapter({ query: queryWith(() => [init, ...turn()], seen), permissions, agentFolder: () => ({ dir: mine, read: true, write }) })
      const agent = { ...getAgent(), allowedTools: ['sdk:Read', 'sdk:Write', 'sdk:Glob'] }
      const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
      await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))
      return seen.at(-1)!.options?.canUseTool as (name: string, input: Record<string, unknown>, options: unknown) => Promise<{ behavior: string; message?: string }>
    }
    const gate = await run(true)
    assert.strictEqual((await gate('Read', { file_path: join(mine, 'notas.md') }, {})).behavior, 'allow')
    assert.strictEqual((await gate('Write', { file_path: join(mine, 'notas.md'), content: 'x' }, {})).behavior, 'allow')
    for (const [tool, input] of [
      ['Read', { file_path: join(data, 'global', 'agents', 'outro', 'a.md') }],
      ['Glob', { pattern: join(data, 'projects', 'alfa', 'agents', 'leo', '**') }],
    ] as const) {
      const result = await gate(tool, input, {})
      assert.deepStrictEqual([result.behavior, /another agent/.test(result.message ?? '')], ['deny', true], `${tool}: ${result.message}`)
    }
    // Fora da pasta, a regra decide (aqui, nega).
    assert.strictEqual((await gate('Read', { file_path: '/srv/app/notas.md' }, {})).behavior, 'deny')
    const reader = await run(false)
    assert.match((await reader('Write', { file_path: join(mine, 'b.md'), content: 'x' }, {})).message ?? '', /read-only for you/)
  })

  it('⛔ a pasta de uma skill compartilhada com o projeto: Read lê, nada grava, o resto do projeto de origem e parada de compartilhar negam', async () => {
    const seen: TQueryParams[] = []
    const init = { type: 'system', subtype: 'init', session_id: 'cli-1', tools: ['Read', 'Write'] }
    const data = dataDir()
    const shared = join(data, 'projects', 'alfa', 'skills', 'deploy')
    let folders = [shared]
    const permissions = { check: () => ({ allowed: false, layer: 'default' as const, reason: 'sem regra' }) }
    const adapter = new ClaudeAgentAdapter({ query: queryWith(() => [init, ...turn()], seen), permissions, sharedFolders: () => folders })
    const agent = { ...getAgent(), allowedTools: ['sdk:Read', 'sdk:Write'] }
    const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, { conversationProjectId: 'beta' }))
    const gate = seen.at(-1)!.options?.canUseTool as (name: string, input: Record<string, unknown>, options: unknown) => Promise<{ behavior: string; message?: string }>
    assert.strictEqual((await gate('Read', { file_path: join(shared, 'scripts', 'run.sh') }, {})).behavior, 'allow')
    assert.strictEqual((await gate('Write', { file_path: join(shared, 'scripts', 'run.sh'), content: 'x' }, {})).behavior, 'deny')
    assert.strictEqual((await gate('Read', { file_path: join(data, 'projects', 'alfa', 'skills', 'privada', 'x.sh') }, {})).behavior, 'deny')
    assert.strictEqual((await gate('Read', { file_path: join(data, 'projects', 'alfa', 'nota.md') }, {})).behavior, 'deny')
    folders = []
    assert.strictEqual((await gate('Read', { file_path: join(shared, 'scripts', 'run.sh') }, {})).behavior, 'deny')
  })

  it('⛔ a saída grande que o CLI guardou (tool-results): a conversa lê a DELA, não grava, e a transcrição e as outras conversas seguem fechadas', async () => {
    const seen: TQueryParams[] = []
    const init = { type: 'system', subtype: 'init', session_id: CLI_SESSION_ID, tools: ['Read', 'Write'] }
    const permissions = { check: () => ({ allowed: false, layer: 'default' as const, reason: 'sem regra' }) }
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [init, ...turn()], seen),
      permissions,
      connections: { connection: (id) => ({ providerId: id, name: 'Claude', protocol: EProvider.CLAUDE, key: 'sk-ant-x' }) },
    })
    const agent = { ...getAgent(), allowedTools: ['sdk:Read', 'sdk:Write'] }
    const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))
    const options = seen.at(-1)!.options!
    const gate = options.canUseTool as (name: string, input: Record<string, unknown>, options: unknown) => Promise<{ behavior: string; message?: string }>
    const home = join(dataDir(), 'claude-cli', 'projects', realpathSync(options.cwd!).replace(/[^a-zA-Z0-9]/g, '-'))
    const mine = join(home, CLI_SESSION_ID, 'tool-results')
    const other = join(home, 'outra-conversa', 'tool-results')
    // Antes de o CLI criar a pasta, nada abre.
    assert.strictEqual((await gate('Read', { file_path: join(mine, 'toolu_1.json') }, {})).behavior, 'deny')
    for (const dir of [mine, other]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'toolu_1.json'), '{}')
    }
    writeFileSync(join(home, `${CLI_SESSION_ID}.jsonl`), '{}')
    assert.strictEqual((await gate('Read', { file_path: join(mine, 'toolu_1.json') }, {})).behavior, 'allow')
    assert.strictEqual((await gate('Write', { file_path: join(mine, 'toolu_1.json'), content: 'x' }, {})).behavior, 'deny')
    assert.strictEqual((await gate('Read', { file_path: join(other, 'toolu_1.json') }, {})).behavior, 'deny')
    assert.strictEqual((await gate('Read', { file_path: join(home, `${CLI_SESSION_ID}.jsonl`) }, {})).behavior, 'deny')
  })

  it('⛔ agente compartilhado: as pastas só leitura saem do projeto DA CONVERSA e do agente (a skill da origem liberada a ele), e a pasta própria vem com o projeto da conversa', async () => {
    const seen: TQueryParams[] = []
    const init = { type: 'system', subtype: 'init', session_id: 'cli-1', tools: ['Read'] }
    const data = dataDir()
    const origin = join(data, 'projects', 'alfa', 'skills', 'deploy')
    const asked: Array<[string | undefined, string | undefined]> = []
    const own: Array<[string, string | undefined]> = []
    const permissions = { check: () => ({ allowed: false, layer: 'default' as const, reason: 'sem regra' }) }
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [init, ...turn()], seen),
      permissions,
      sharedFolders: (project, agentId) => (asked.push([project, agentId]), agentId ? [origin] : []),
      agentFolder: (agentId, project) => (own.push([agentId, project]), undefined),
    })
    // O agente chega ao adapter como o global (sem o projeto de origem); a conversa é do beta.
    const agent = { ...getAgent(), allowedTools: ['sdk:Read'] }
    const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, { conversationProjectId: 'beta' }))
    const gate = seen.at(-1)!.options?.canUseTool as (name: string, input: Record<string, unknown>, options: unknown) => Promise<{ behavior: string }>
    assert.strictEqual((await gate('Read', { file_path: join(origin, 'scripts', 'run.sh') }, {})).behavior, 'allow')
    assert.deepStrictEqual(asked.at(-1), ['beta', CLAUDE_TEST_AGENT.id])
    assert.deepStrictEqual(own.at(-1), [CLAUDE_TEST_AGENT.id, 'beta'])
  })

  it('liga só as nativas do agente no CLI, o gate as aprova, e avisa quando o init não traz uma delas', async () => {
    const seen: TQueryParams[] = []
    const init = { type: 'system', subtype: 'init', session_id: 'cli-1', tools: ['WebSearch'] }
    const adapter = new ClaudeAgentAdapter({ query: queryWith(() => [init, ...turn()], seen) })
    const agent = { ...getAgent(), allowedTools: ['sdk:WebSearch', 'sdk:Read'] }
    const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(agent, session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(seen[0].options?.tools, ['WebSearch', 'Read'])
    const gate = seen[0].options?.canUseTool as (name: string, input: Record<string, unknown>, options: unknown) => Promise<{ behavior: string }>
    assert.strictEqual((await gate('WebSearch', {}, {})).behavior, 'allow')
    assert.strictEqual((await gate('Read', {}, {})).behavior, 'allow')
    assert.strictEqual((await gate('Bash', {}, {})).behavior, 'deny')
    assert.ok(events.find((event) => event.type === 'warning' && String(event.payload.message).includes('Read')))
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

    // ⛔ Sempre pelo iterável (a entrada fica aberta até o `result`): o texto vai como conteúdo, o anexo como blocos.
    assert.strictEqual(await promptText(seen[0].prompt), 'plain')
    assert.strictEqual(typeof seen[1].prompt, 'object')
  })

  it('hands tools to the SDK as MCP servers, local and remote', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    const servers = seen[0].options?.mcpServers ?? {}
    assert.deepStrictEqual(Object.keys(servers).sort(), ['local', 'mcp_crm'])
    // Built-ins seguem desligados: o agente não ganha Bash/Read sobre a máquina do host.
    assert.deepStrictEqual(seen[0].options?.tools, [])
    // ⚖️ O nome completo das do gateway vai no prompt: o modelo chamava `use_resource` sem o prefixo.
    assert.ok(String(seen[0].options?.systemPrompt).endsWith(CLAUDE_TOOL_NAMES))
    assert.match(CLAUDE_TOOL_NAMES, /mcp__local__use_resource/)
  })

  it('omits the remote server when no MCP is connected', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(false) })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.deepStrictEqual(Object.keys(seen[0].options?.mcpServers ?? {}), ['local'])
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
    assert.strictEqual((await gate('mcp__local__run_bash', {}, options))?.behavior, 'allow')
    assert.strictEqual((await gate('mcp__mcp_crm__read_file', {}, options))?.behavior, 'allow')
    // ⛔ Do servidor escolhido, só a ferramenta escolhida; de servidor que o agente não tem, nada.
    assert.strictEqual((await gate('mcp__mcp_crm__delete_all', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('mcp__mcp_outro__read_file', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('Bash', {}, options))?.behavior, 'deny')
    assert.strictEqual((await gate('mcp__local__search_web', {}, options))?.behavior, 'deny')
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
    assert.strictEqual((await gate!('mcp__local__delegate_to_agent', {}, options))?.behavior, 'allow')
    assert.strictEqual((await gate!('mcp__local__run_bash', {}, options))?.behavior, 'deny')
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

  it('a janela do modelo da conversa vem do `modelUsage` do runtime; a de um subagente não serve', () => {
    const usage = { 'claude-haiku-5-5': { contextWindow: 200_000 }, 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } }
    assert.deepStrictEqual(windowOf(usage, 'claude-opus-5-5'), { contextWindow: 1_000_000 })
    assert.deepStrictEqual(windowOf({ 'claude-opus-5-5-20261001': { contextWindow: 500_000 } }, 'claude-opus-5-5'), { contextWindow: 500_000 })
    assert.deepStrictEqual(windowOf(usage, 'claude-fable-5-1'), {})
    assert.deepStrictEqual(windowOf({ 'claude-opus-5-5': { contextWindow: 0 } }, 'claude-opus-5-5'), {})
    assert.deepStrictEqual(windowOf(undefined, 'claude-opus-5-5'), {})
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

  it('⛔ a chamada recusada ou que falhou (`is_error`) sai como erro, com o texto — não como resultado', async () => {
    const adapter = new ClaudeAgentAdapter({
      query: queryWith(() => [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__mcp_gateway__list_docs', input: {} }] } },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Tool "list_docs" is not enabled for this agent.' }] }] },
        },
      ]),
    })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'hi' }, {}))

    assert.ok(!events.some((e) => e.type === 'tool.result'))
    assert.deepStrictEqual(events.find((e) => e.type === 'tool.error')?.payload, { tool: 'list_docs', message: 'Tool "list_docs" is not enabled for this agent.' })
  })

  it('⛔ a entrada do CLI fica aberta até o `result`: uma ferramenta longa (a delegação) não perde a resposta', async () => {
    const states: string[] = []
    const query = ((params: TQueryParams) =>
      (async function* () {
        const input = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
        await input.next()
        let closed = false
        void input.next().then((step) => (closed = !!step.done))
        // A ferramenta rodando (e uma tarefa lateral do CLI no meio): a entrada não pode ter fechado.
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'delegate_to_agent', input: {} }] } }
        await new Promise((resolve) => setTimeout(resolve, 20))
        states.push(closed ? 'fechada antes' : 'aberta')
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'resposta do Zeus' }] } }
        yield turn().at(-1)
        await new Promise((resolve) => setTimeout(resolve, 0))
        states.push(closed ? 'fechada depois' : 'ainda aberta')
      })()) as unknown as TQuery
    const adapter = new ClaudeAgentAdapter({ query })
    const session = await adapter.createSession(getAgent(), { agentId: CLAUDE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'delegue' }, {}))
    assert.deepStrictEqual(states, ['aberta', 'fechada depois'])
    assert.ok(events.some((event) => event.type === 'tool.result'))
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

    it('⛔ C3: o Bash nativo do agente de projeto é recusado (nem pelo hook): sem cerco antigo, sem leitura do projeto inteiro', async () => {
      const { options: sent, fake } = await run(true)
      const denied = (await sent.canUseTool!('Bash', { command: 'cat .env' }, options)) as { behavior: string; message?: string }
      assert.deepStrictEqual([denied.behavior, /run_bash/.test(denied.message ?? '')], ['deny', true])
      const hook = sent.hooks!.PreToolUse![0].hooks[0]
      const output = (await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 't2' } as never, 't2', {
        signal: options.signal,
      })) as { hookSpecificOutput: { permissionDecision: string } }
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny')
      assert.deepStrictEqual(fake.calls, [])
      const outside = (await sent.canUseTool!('Read', { file_path: '/etc/hosts' }, options)) as { behavior: string; message?: string }
      assert.deepStrictEqual([outside.behavior, /fora da pasta do projeto/.test(outside.message ?? '')], ['deny', true])
      const inside = (await sent.canUseTool!('Write', { file_path: 'notas.md', content: 'x' }, options)) as { behavior: string }
      assert.strictEqual(inside.behavior, 'allow')
    })

    const globalGate = async (tools: string[], extra: Partial<IAgent> = {}) => {
      const seen: TQueryParams[] = []
      const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true), sandbox: sandbox(true) })
      const global = { ...getAgent(), allowedTools: tools, ...extra }
      const session = await adapter.createSession(global, { agentId: CLAUDE_TEST_AGENT.id })
      await drain(adapter.sendMessage(global, session.id, { text: 'oi' }, {}))
      return seen[0].options!
    }

    it('⛔ C3/C4: agente global que não é adminOnly não tem Bash, Grep nem Glob nativos (/proc/environ, HOME, pastas de outros agentes)', async () => {
      const sent = await globalGate(['sdk:Bash', 'sdk:Grep', 'sdk:Glob', 'sdk:Read'])
      for (const [tool, input] of [
        ['Bash', { command: 'cat /proc/$PPID/environ' }],
        ['Grep', { pattern: '.', path: '/' }],
        ['Glob', { pattern: '**/.env' }],
      ] as const) {
        const decision = (await sent.canUseTool!(tool, input, options)) as { behavior: string }
        assert.strictEqual(decision.behavior, 'deny', tool)
      }
    })

    it('⛔ o Bash nativo é recusado até para o agente global adminOnly (roda sem cerco, lê /proc/$PPID/environ); Grep e Glob seguem', async () => {
      const sent = await globalGate(['sdk:Bash', 'sdk:Grep'], { adminOnly: true })
      const bash = (await sent.canUseTool!('Bash', { command: 'cat /proc/$PPID/environ' }, options)) as { behavior: string; message?: string }
      assert.strictEqual(bash.behavior, 'deny')
      assert.match(bash.message ?? '', /run_bash/)
      const grep = (await sent.canUseTool!('Grep', { pattern: 'x', path: '.' }, options)) as { behavior: string }
      assert.strictEqual(grep.behavior, 'allow')
    })

    it('⛔ M9: o WebFetch passa pelo portão de rede (loopback, porta do gateway, metadados), não só pela regra', async () => {
      const sent = await globalGate(['sdk:WebFetch'])
      const fetch = async (url: string) => (await sent.canUseTool!('WebFetch', { url, prompt: 'x' }, options)) as { behavior: string; message?: string }
      for (const url of ['http://localhost:3000/api', 'http://127.0.0.1:8080/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]:9/', 'file:///etc/passwd', 'não é url']) {
        assert.strictEqual((await fetch(url)).behavior, 'deny', url)
      }
    })

    it('⛔ o ambiente do CLI liga o scrub das credenciais nos subprocessos', () => {
      assert.strictEqual(cliEnv({ key: 'k', compatible: false }).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1')
    })

    it('⛔ worktree: o Edit pela regra escrita a partir da pasta do projeto passa; o que a regra não cobre, não', async () => {
      const project = realpathSync(mkdtempSync(join(tmpdir(), 'gw-claude-wt-')))
      const worktree = join(project, 'repositories', 'logiccus', '_worktrees', 'EP-1')
      mkdirSync(join(worktree, 'mcps', 'x'), { recursive: true })
      try {
        const agentRules: IPermissionRule[] = [{ category: 'write', pattern: 'repositories/logiccus/_worktrees/*/**/*.test.ts', decision: 'allow' }]
        const permissions: IPermissionChecker = { check: (_asker, subject) => decide(subject, { agent: agentRules }), layers: () => ({ agent: agentRules, system: [] }) }
        const seen: TQueryParams[] = []
        const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true), sandbox: sandbox(true), permissions })
        const agent = { ...getAgent(), allowedTools: ['sdk:Edit'] }
        const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
        await drain(adapter.sendMessage(agent, session.id, { text: 'oi' }, { workFolder: { dir: worktree, projectDir: project } } as never))
        const hook = seen[0].options!.hooks!.PreToolUse![0].hooks[0]
        const edit = async (file: string) =>
          (
            (await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, tool_use_id: 't' } as never, 't', {
              signal: options.signal,
            })) as { hookSpecificOutput: { permissionDecision: string } }
          ).hookSpecificOutput.permissionDecision
        assert.strictEqual(await edit('mcps/x/a.test.ts'), 'allow')
        assert.strictEqual(await edit(join(worktree, 'mcps/x/a.test.ts')), 'allow')
        assert.strictEqual(await edit('mcps/x/a.ts'), 'deny')
      } finally {
        rmSync(project, { recursive: true, force: true })
      }
    })

    it('⛔ laço: o PreToolUse recusa a nativa repetida; as locais ficam para o envoltório delas', async () => {
      const seen: TQueryParams[] = []
      const loops = new LoopGuard(() => ({ refuseAt: 2, stopAt: 9, maxErrors: 9 }))
      const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true), sandbox: sandbox(true), loops })
      const global = { ...getAgent(), allowedTools: ['sdk:Grep'], adminOnly: true }
      const session = await adapter.createSession(global, { agentId: CLAUDE_TEST_AGENT.id })
      await drain(adapter.sendMessage(global, session.id, { text: 'oi' }, {}))
      const hook = seen[0].options!.hooks!.PreToolUse![0].hooks[0]
      const call = async (tool: string, input: Record<string, unknown>) =>
        (
          (await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't' } as never, 't', { signal: options.signal })) as {
            hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string }
          }
        ).hookSpecificOutput

      loops.open(session.id)
      assert.strictEqual((await call('Grep', { pattern: 'x' })).permissionDecision, 'allow')
      const second = await call('Grep', { pattern: 'x' })
      assert.deepStrictEqual([second.permissionDecision, /detector de laço/.test(second.permissionDecisionReason ?? '')], ['deny', true])
      assert.strictEqual((await call('Grep', { pattern: 'y' })).permissionDecision, 'allow', 'argumento diferente não conta')
      await call('mcp__local__run_bash', { command: 'ls' })
      assert.notStrictEqual((await call('mcp__local__run_bash', { command: 'ls' })).permissionDecisionReason?.includes('laço'), true)
    })

    it('diagnóstico: o PostToolUse das nativas de edição devolve o diagnóstico como contexto; desligado, nem entra', async () => {
      const asked: Array<{ file: string; root: string }> = []
      const diagnostics = {
        async after(file: string, root: string) {
          asked.push({ file, root })
          return 'Diagnóstico: tsc ok'
        },
      }
      const turnOf = async (agent: ReturnType<typeof getAgent>) => {
        const seen: TQueryParams[] = []
        const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true), sandbox: sandbox(true), diagnostics })
        const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
        await drain(adapter.sendMessage(agent, session.id, { text: 'oi' }, { workFolder: { dir: '/w', projectDir: '/p' } } as never))
        return seen[0].options!.hooks!
      }
      assert.deepStrictEqual((await turnOf({ ...getAgent(), allowedTools: ['sdk:Edit'] })).PostToolUse, [])

      const hooks = await turnOf({ ...getAgent(), allowedTools: ['sdk:Edit'], diagnostics: { typecheck: true, timeoutSeconds: 30 } })
      const matcher = hooks.PostToolUse![0]
      assert.deepStrictEqual([matcher.matcher, matcher.timeout], ['Write|Edit|MultiEdit', 45])
      const post = (tool: string, input: unknown) =>
        matcher.hooks[0]({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: {}, tool_use_id: 't' } as never, 't', { signal: options.signal })
      assert.deepStrictEqual(await post('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }), {
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Diagnóstico: tsc ok' },
      })
      assert.deepStrictEqual(await post('NotebookEdit', { notebook_path: 'x.ipynb' }), {}, 'o matcher é regex: o nome é conferido de novo')
      assert.deepStrictEqual(asked, [{ file: '/w/src/a.ts', root: '/w' }])
    })

    it('mensagem durante o turno: o PostToolUse de toda ferramenta leva o que chegou, uma vez', async () => {
      const seen: TQueryParams[] = []
      const adapter = new ClaudeAgentAdapter({ query: queryWith(turn, seen), catalog: catalogWith(true), sandbox: sandbox(true) })
      const agent = { ...getAgent(), allowedTools: ['sdk:Bash'], adminOnly: true }
      const session = await adapter.createSession(agent, { agentId: CLAUDE_TEST_AGENT.id })
      const queue = ['use o banco B']
      await drain(adapter.sendMessage(agent, session.id, { text: 'oi', interjections: () => queue.splice(0) }, {}))
      const hook = seen[0].options!.hooks!.PostToolUse![0]
      assert.strictEqual(hook.matcher, undefined, 'toda ferramenta')
      const post = () =>
        hook.hooks[0]({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 't' } as never, 't', {
          signal: options.signal,
        }) as Promise<{
          hookSpecificOutput?: { additionalContext?: string }
        }>
      assert.match((await post()).hookSpecificOutput?.additionalContext ?? '', /^\[Mensagem nova da pessoa[^\]]*\]\n\nuse o banco B$/)
      assert.deepStrictEqual(await post(), {}, 'a fila já foi tirada')
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

  const sub: IAgent = { ...agent, providers: [{ provider: 'claude-sub', models: ['claude-sonnet-5-5'] }] }
  const connections = { connection: () => ({ providerId: 'claude-sub', name: 'Claude', protocol: EProvider.CLAUDE_SUB, key: 'tok-do-cofre' }) } as never

  it('⛔ assinatura com o token do cofre: as conversas do CLI no volume de dados (no pod o HOME é só leitura)', async () => {
    const seen: TQueryParams[] = []
    const adapter = new ClaudeAgentAdapter({ query: queryWith(seen), subscription: true, connections })
    const session = await adapter.createSession(sub, { agentId: sub.id })
    for await (const _event of adapter.sendMessage(sub, session.id, { text: 'oi' }, {})) void _event
    assert.strictEqual(seen[0].options?.env?.CLAUDE_CONFIG_DIR, join(dir, 'claude-cli'))
    assert.strictEqual(seen[0].options?.env?.CLAUDE_CODE_OAUTH_TOKEN, 'tok-do-cofre')
  })

  it('⚠️ o CLI perdeu a conversa: em vez do `resume` que falharia ("No conversation found"), outra, com a transcrição', async () => {
    const LOST = '99999999-2222-4333-8444-555555555555'
    const seen: TQueryParams[] = []
    const lostQuery = ((params: TQueryParams) => {
      seen.push(params)
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: LOST }
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
      })()
    }) as unknown as TQuery
    const store = new SessionStore()
    const adapter = new ClaudeAgentAdapter({ query: lostQuery, subscription: true, connections, store })
    const session = await adapter.createSession(sub, { agentId: sub.id })
    for await (const _event of adapter.sendMessage(sub, session.id, { text: 'salva o teste' }, {})) void _event
    store.get(session.id)!.transcript = [{ request: 'salva o teste', text: 'Salvo?', tools: [], by: 'claude-sub · claude-sonnet-5-5' }]

    for await (const _event of adapter.sendMessage(sub, session.id, { text: 'sim pode salvar' }, {})) void _event
    assert.strictEqual(seen[1].options?.resume, undefined)
    assert.match(String(seen[1].options?.sessionId), /^[0-9a-f-]{36}$/)
    assert.match(await promptText(seen[1].prompt), /salva o teste[\s\S]*sim pode salvar$/)
  })
})

/** O texto da mensagem que o adapter entregou ao SDK (o iterável já liberado: o turno acabou). */
async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === 'string') return prompt
  for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
    const content = message.message.content
    return typeof content === 'string' ? content : JSON.stringify(content)
  }
  return ''
}

describe('preToolUse — o portão no hook', () => {
  type THookInput = Parameters<ReturnType<typeof preToolUse>>[0]
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' }, tool_use_id: 't1' } as unknown as THookInput
  const run = (gate: Parameters<typeof preToolUse>[0]) => preToolUse(gate)(input, 't1', { signal: new AbortController().signal })
  const decisionOf = (output: Awaited<ReturnType<typeof run>>) =>
    (output as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput

  it('o que o portão libera passa; o que ele nega volta com o motivo', async () => {
    assert.strictEqual(decisionOf(await run(async () => ({ behavior: 'allow', updatedInput: {} })))?.permissionDecision, 'allow')
    const denied = decisionOf(await run(async () => ({ behavior: 'deny', message: 'fora da regra' })))
    assert.deepStrictEqual([denied?.permissionDecision, denied?.permissionDecisionReason], ['deny', 'fora da regra'])
  })

  it('⛔ o portão que lança (ou rejeita) NEGA: o erro do hook não vira "sem decisão"', async () => {
    const original = console.error
    console.error = () => undefined
    try {
      const rejected = decisionOf(await run(async () => Promise.reject(new Error('banco fora'))))
      assert.strictEqual(rejected?.permissionDecision, 'deny')
      assert.doesNotMatch(rejected?.permissionDecisionReason ?? '', /banco fora/)
      const thrown = decisionOf(
        await run(() => {
          throw new Error('síncrono')
        }),
      )
      assert.strictEqual(thrown?.permissionDecision, 'deny')
    } finally {
      console.error = original
    }
  })
})
