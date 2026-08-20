import assert from 'node:assert'
import { describe, it } from 'node:test'
import type Anthropic from '@anthropic-ai/sdk'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { ClaudeChatAdapter } from './ClaudeChat.Adapter'

interface IRequestOptions {
  signal?: AbortSignal
}
type TCreate = (params: Anthropic.MessageCreateParamsStreaming, options?: IRequestOptions) => Promise<unknown>

describe('ClaudeChatAdapter', () => {
  const getAgent = (): IAgent => ({
    id: 'sysops-agent',
    name: 'SysOps',
    provider: EProvider.CLAUDE,
    systemPrompt: 'You are a system operator.',
    models: ['claude-sonnet-5'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['run_bash'],
  })

  const clientWith = (create: TCreate): Anthropic => ({ messages: { create } }) as unknown as Anthropic

  const drain = async (events: AsyncIterable<IAgentEvent>): Promise<IAgentEvent[]> => {
    const collected: IAgentEvent[] = []
    for await (const event of events) collected.push(event)
    return collected
  }

  const textOf = (events: IAgentEvent[]): string =>
    events
      .filter((e) => e.type === 'text.delta')
      .map((e) => e.payload.text)
      .join('')

  it('creates a chat session carrying model, reasoning and language', async () => {
    const adapter = new ClaudeChatAdapter({ client: clientWith(async () => []) })

    const session = await adapter.createSession(getAgent(), {
      agentId: 'sysops-agent',
      model: 'claude-opus-5',
      reasoning: 'xhigh',
      language: 'Portuguese',
    })

    assert.ok(session.id.startsWith('claude-chat-'))
    assert.strictEqual(session.provider, EProvider.CLAUDE)
    assert.strictEqual(session.mode, EMode.CHAT)
  })

  it('streams text and usage, and sends no tools at all', async () => {
    let sent: Anthropic.MessageCreateParamsStreaming | undefined

    const adapter = new ClaudeChatAdapter({
      client: clientWith(async (params) => {
        sent = params
        return (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 11 } } }
          yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } }
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }
          yield { type: 'message_delta', usage: { output_tokens: 7 } }
        })()
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent', reasoning: 'high' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }))

    assert.strictEqual(events[0].type, 'message.started')
    assert.strictEqual(textOf(events), 'Hello world')
    assert.ok(events.find((e) => e.type === 'reasoning.delta' && e.payload.text === 'hmm'))
    assert.ok(events.find((e) => e.type === 'usage' && e.payload.inputTokens === 11))
    assert.ok(events.find((e) => e.type === 'usage' && e.payload.outputTokens === 7))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')

    // A lane chat é conversa pura: nada de tools nem de loop de tool.
    assert.strictEqual('tools' in (sent ?? {}), false)
    assert.strictEqual(
      events.some((e) => e.type === 'tool.started'),
      false,
    )
    assert.strictEqual(sent?.output_config?.effort, 'high')
  })

  it('carries the language instruction into the system prompt once', async () => {
    let sent: Anthropic.MessageCreateParamsStreaming | undefined
    const adapter = new ClaudeChatAdapter({
      client: clientWith(async (params) => {
        sent = params
        return (async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
        })()
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent', language: 'Portuguese' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Oi' }))
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Oi de novo' }))

    const occurrences = String(sent?.system).split('reply exclusively in Portuguese').length - 1
    assert.strictEqual(occurrences, 1)
  })

  it('maps images and PDFs, and warns about anything else', async () => {
    let sent: Anthropic.MessageCreateParamsStreaming | undefined
    const adapter = new ClaudeChatAdapter({
      client: clientWith(async (params) => {
        sent = params
        return (async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
        })()
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events = await drain(
      adapter.sendMessage(getAgent(), session.id, {
        text: 'Look',
        files: [
          { name: 'a.png', mimeType: 'image/png', data: 'aaa' },
          { name: 'b.pdf', mimeType: 'application/pdf', data: 'bbb' },
          { name: 'c.zip', mimeType: 'application/zip', data: 'ccc' },
        ],
      }),
    )

    const content = sent?.messages[0].content
    assert.ok(Array.isArray(content))
    assert.deepStrictEqual(
      (content as Anthropic.ContentBlockParam[]).map((block) => block.type),
      ['text', 'image', 'document'],
    )
    assert.ok(events.find((e) => e.type === 'warning' && e.payload.message.includes('c.zip')))
  })

  it('keeps the transcript usable after a turn that produced no text', async () => {
    const adapter = new ClaudeChatAdapter({
      client: clientWith(async () => {
        throw new Error('API down')
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const failed = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }))

    const error = failed.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error')
    assert.strictEqual(error.payload.message, 'API down')
  })

  it('reports an aborted turn instead of an error', async () => {
    const adapter = new ClaudeChatAdapter({
      client: clientWith(async (_params, options) =>
        (async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }
          if (options?.signal?.aborted) throw new Error('Request was aborted.')
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'never' } }
        })(),
      ),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'sysops-agent' })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'Hi' })) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.strictEqual(textOf(events), 'partial')
    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })

  it('reports a missing session rather than throwing', async () => {
    const adapter = new ClaudeChatAdapter({ client: clientWith(async () => []) })
    const events = await drain(adapter.sendMessage(getAgent(), 'claude-chat-nope', { text: 'Hi' }))

    assert.strictEqual(events.length, 1)
    assert.strictEqual(events[0].type, 'error')
  })
})
