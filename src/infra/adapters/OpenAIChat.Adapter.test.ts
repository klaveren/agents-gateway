import assert from 'node:assert'
import { describe, it } from 'node:test'
import type OpenAI from 'openai'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { OpenAIChatAdapter } from './OpenAIChat.Adapter'

interface IRequestOptions {
  signal?: AbortSignal
}
type TCreate = (params: OpenAI.Chat.ChatCompletionCreateParamsStreaming, options?: IRequestOptions) => Promise<unknown>

describe('OpenAIChatAdapter', () => {
  const getAgent = (): IAgent => ({
    id: 'analyst-agent',
    name: 'Data Analyst',
    provider: EProvider.OPENAI,
    systemPrompt: 'You are a Data Analyst Agent.',
    models: ['gpt-5.6-sol'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['search_web'],
  })

  const clientWith = (create: TCreate): OpenAI => ({ chat: { completions: { create } } }) as unknown as OpenAI

  const drain = async (events: AsyncIterable<IAgentEvent>): Promise<IAgentEvent[]> => {
    const collected: IAgentEvent[] = []
    for await (const event of events) collected.push(event)
    return collected
  }

  it('creates a chat session on the chat lane', async () => {
    const adapter = new OpenAIChatAdapter({ client: clientWith(async () => []) })
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })

    assert.ok(session.id.startsWith('openai-chat-'))
    assert.strictEqual(session.mode, EMode.CHAT)
  })

  it('streams text, asks for usage and sends no tools', async () => {
    let sent: OpenAI.Chat.ChatCompletionCreateParamsStreaming | undefined

    const adapter = new OpenAIChatAdapter({
      client: clientWith(async (params) => {
        sent = params
        return (async function* () {
          yield { choices: [{ delta: { content: 'Thinking' } }] }
          yield { choices: [{ delta: { content: '... done' } }] }
          yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } }
        })()
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent', reasoning: 'low' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }))

    const text = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => e.payload.text)
      .join('')

    assert.strictEqual(text, 'Thinking... done')
    assert.ok(events.find((e) => e.type === 'usage' && e.payload.outputTokens === 9))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')

    assert.strictEqual('tools' in (sent ?? {}), false)
    assert.strictEqual(sent?.reasoning_effort, 'low')
    assert.deepStrictEqual(sent?.stream_options, { include_usage: true })
    assert.strictEqual(sent?.messages[0].role, 'system')
  })

  it('sends a PDF as a file part instead of dropping it', async () => {
    let sent: OpenAI.Chat.ChatCompletionCreateParamsStreaming | undefined
    const adapter = new OpenAIChatAdapter({
      client: clientWith(async (params) => {
        sent = params
        return (async function* () {
          yield { choices: [{ delta: { content: 'ok' } }] }
        })()
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })
    await drain(
      adapter.sendMessage(getAgent(), session.id, {
        text: 'Read it',
        files: [
          { name: 'a.png', mimeType: 'image/png', data: 'aaa' },
          { name: 'report.pdf', mimeType: 'application/pdf', data: 'bbb' },
        ],
      }),
    )

    const content = sent?.messages[1].content
    assert.ok(Array.isArray(content))
    assert.deepStrictEqual(
      (content as OpenAI.Chat.ChatCompletionContentPart[]).map((part) => part.type),
      ['text', 'image_url', 'file'],
    )
  })

  it('surfaces provider failures as a normalized error event', async () => {
    const adapter = new OpenAIChatAdapter({
      client: clientWith(async () => {
        throw new Error('API down')
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }))
    const error = events.find((e) => e.type === 'error')

    assert.ok(error && error.type === 'error')
    assert.strictEqual(error.payload.message, 'API down')
  })

  it('reports an aborted turn instead of an error', async () => {
    const adapter = new OpenAIChatAdapter({
      client: clientWith(async (_params, options) =>
        (async function* () {
          yield { choices: [{ delta: { content: 'partial' } }] }
          if (options?.signal?.aborted) throw new Error('Request was aborted.')
          yield { choices: [{ delta: { content: 'never' } }] }
        })(),
      ),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'Hi' })) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })
})
