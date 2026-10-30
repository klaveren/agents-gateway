import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type Anthropic from '@anthropic-ai/sdk'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IConversationTurn } from '@domain/models/Conversation.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { ClaudeAgentAdapter } from '@infra/adapters/ClaudeAgent.Adapter'
import { ClaudeChatAdapter } from '@infra/adapters/ClaudeChat.Adapter'
import { projectWorkspacePath } from '@infra/adapters/support/Subscription.Workspace'
import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

type TQuery = typeof query
type TQueryParams = Parameters<TQuery>[0]

/**
 * O contexto mínimo do agente (ver `Ambient.Policy`) com os adapters DE VERDADE (o SDK falso): o "## Ambiente" no system
 * prompt, e o id da conversa na entrada do modelo — no primeiro turno e quando o histórico recomeça, nunca gravado.
 */
describe('AgentProvider — o ambiente e o id da conversa', () => {
  let data: string
  let previousDb: string | undefined
  before(() => {
    // A pasta do projeto mora ao lado do banco (`dataDir`): num diretório do teste, nunca no repositório.
    data = mkdtempSync(join(tmpdir(), 'gw-ambient-'))
    previousDb = process.env.CONVERSATIONS_DB
    process.env.CONVERSATIONS_DB = join(data, 'conversations.db')
  })
  after(() => {
    if (previousDb === undefined) delete process.env.CONVERSATIONS_DB
    else process.env.CONVERSATIONS_DB = previousDb
    rmSync(data, { recursive: true, force: true })
  })

  const dev: IAgent = {
    id: 'dev',
    name: 'Dev',
    projectId: 'alfa',
    providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
    systemPrompt: 'Você escreve código.',
    modes: [EMode.AGENT, EMode.CHAT],
    allowedTools: [],
  }
  const atlas: IAgent = { ...dev, id: 'atlas', name: 'Atlas', projectId: undefined, systemPrompt: 'Você monta agentes.' }

  function setup() {
    const store = new SessionStore()
    const queries: TQueryParams[] = []
    const chats: Array<{ system: string; last: string }> = []
    const claudeQuery = ((params: TQueryParams) => {
      queries.push(params)
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' }
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'feito' } } }
        yield { type: 'result', subtype: 'success', is_error: false, result: 'feito', usage: { input_tokens: 1, output_tokens: 1 } }
      })()
    }) as unknown as TQuery
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsStreaming) => {
          const last = params.messages[params.messages.length - 1].content
          const text = typeof last === 'string' ? last : last.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n')
          chats.push({ system: String(params.system), last: text })
          return (async function* () {
            yield { type: 'message_start', message: { usage: { input_tokens: 5 } } }
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'RESUMO da conversa' } }
            yield { type: 'message_delta', usage: { output_tokens: 3 } }
          })()
        },
      },
    } as unknown as Anthropic
    const config = (id: string) =>
      id === EProvider.CLAUDE ? { id, name: id, protocol: EProvider.CLAUDE, official: true, enabled: true, createdAt: new Date(), updatedAt: new Date() } : undefined
    const provider = new AgentProvider(
      new Map<string, IAgentAdapter>([
        [adapterKey(EProvider.CLAUDE, EMode.AGENT), new ClaudeAgentAdapter({ store, query: claudeQuery })],
        [adapterKey(EProvider.CLAUDE, EMode.CHAT), new ClaudeChatAdapter({ store, client })],
      ]),
      store,
      new NullSettingsRepository({ audience: 'all' }),
      { list: () => [dev, atlas], get: (id) => [dev, atlas].find((agent) => agent.id === id) },
      { list: () => [], get: config, connection: (id) => (config(id) ? { providerId: id, name: id, protocol: EProvider.CLAUDE, key: 'k' } : undefined) },
      undefined,
      undefined,
      undefined,
      undefined,
      (id) => (id === 'alfa' ? 'Alfa' : undefined),
    )
    return { provider, store, queries, chats }
  }

  const run = async (stream: AsyncIterable<IAgentEvent>) => {
    const events: IAgentEvent[] = []
    for await (const event of stream) events.push(event)
    return events
  }

  it('Claude Agent SDK: "## Ambiente" com o projeto e a MESMA pasta do `cwd`; o id da conversa só no primeiro turno', async () => {
    const { provider, store, queries } = setup()
    const session = await provider.createSession({ agentId: 'dev', mode: EMode.AGENT, metadata: { project: 'alfa' } })
    await run(provider.sendMessage(session.id, { text: 'oi' }))
    await run(provider.sendMessage(session.id, { text: 'e agora?' }))

    const directory = projectWorkspacePath('alfa')
    assert.strictEqual(
      queries[0].options?.systemPrompt,
      `Você escreve código.\n\n## Ambiente\n- Agente: dev.\n- Projeto: Alfa (projectId "alfa").\n- Diretório de trabalho: ${directory} — persistente e compartilhado pelas conversas do projeto. Fora dele você não lê nem grava.`,
    )
    assert.strictEqual(queries[0].options?.cwd, directory, 'o diretório dito é o `cwd` da lane')
    assert.strictEqual(queries[0].prompt, `<contexto>id desta conversa: ${session.id}</contexto>\n\noi`)
    assert.strictEqual(queries[1].prompt, 'e agora?', 'o id vai uma vez por histórico')
    assert.deepStrictEqual(
      store.get(session.id)!.transcript?.map((turn) => turn.request),
      ['oi', 'e agora?'],
      'a transcrição (o repasse) guarda o que a pessoa escreveu',
    )
  })

  it('lane de chat: o global sem projeto opera na pasta vazia da conversa; o id volta quando o histórico recomeça (compactação)', async () => {
    const { provider, chats } = setup()
    const session = await provider.createSession({ agentId: 'atlas', mode: EMode.CHAT })
    await run(provider.sendMessage(session.id, { text: 'oi' }))
    await run(provider.sendMessage(session.id, { text: 'segue' }))

    assert.strictEqual(chats[0].system, 'Você monta agentes.\n\n## Ambiente\n- Agente: atlas.\n- Diretório de trabalho: uma pasta vazia, só desta conversa.')
    assert.strictEqual(chats[0].last, `<contexto>id desta conversa: ${session.id}</contexto>\n\noi`)
    assert.strictEqual(chats[1].last, 'segue')

    provider.requestCompaction(session.id)
    await run(provider.sendMessage(session.id, { text: 'e o passo 3?' }))
    // chats[2] é o resumo (o turno oculto); chats[3], o modelo recomeçando com ele.
    assert.match(chats[3].last, new RegExp(`^<contexto>id desta conversa: ${session.id}</contexto>\\n\\n[\\s\\S]*RESUMO da conversa[\\s\\S]*e o passo 3\\?$`))
  })

  it('o global numa conversa do projeto: o projeto atual, e a pasta vazia (o `cwd` é a da conversa)', async () => {
    const { provider, queries } = setup()
    const session = await provider.createSession({ agentId: 'atlas', mode: EMode.AGENT, metadata: { project: 'alfa' } })
    await run(provider.sendMessage(session.id, { text: 'crie um agente' }))
    assert.match(
      String(queries[0].options?.systemPrompt),
      /\n- Projeto atual: Alfa \(projectId "alfa"\)\. Agentes, hooks e conversas que você criar aqui pertencem a este projeto\.\n- Diretório de trabalho: uma pasta vazia, só desta conversa\.$/,
    )
    assert.notStrictEqual(queries[0].options?.cwd, projectWorkspacePath('alfa'))
  })

  it('⛔ o corpo não escolhe o ambiente: o que vier no input é trocado pelo do servidor', async () => {
    const { provider, chats } = setup()
    const session = await provider.createSession({ agentId: 'atlas', mode: EMode.CHAT, ambient: { agentId: 'forjado', directory: '/etc' } })
    await run(provider.sendMessage(session.id, { text: 'oi' }))
    assert.doesNotMatch(chats[0].system, /forjado|\/etc/)
  })

  it('⛔ o id não é gravado no turno nem sai para a tela', async () => {
    const { provider } = setup()
    const turns: IConversationTurn[] = []
    const repository = new (class extends NullConversationRepository {
      override async appendTurn(turn: IConversationTurn) {
        turns.push(turn)
        return turn.index
      }
    })()
    const usecase = new SendMessageUseCase(provider, repository)
    const session = await provider.createSession({ agentId: 'atlas', mode: EMode.CHAT })
    const events = await run(usecase.execute(session.id, { text: 'oi' }))
    await new Promise((resolve) => setImmediate(resolve))

    assert.strictEqual(turns[0]?.request, 'oi')
    assert.ok(!JSON.stringify(events).includes('<contexto>'), 'nenhum evento leva o id como fala')
  })
})
