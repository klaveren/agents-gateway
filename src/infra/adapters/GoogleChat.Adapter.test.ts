import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { GenerateContentRequest, GoogleGenerativeAI, ModelParams } from '@google/generative-ai'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { GoogleChatAdapter } from './GoogleChat.Adapter'

interface ISingleRequestOptions {
  signal?: AbortSignal
}
type TStream = (request: GenerateContentRequest, options?: ISingleRequestOptions) => Promise<unknown>

describe('GoogleChatAdapter', () => {
  const getAgent = (): IAgent => ({
    id: 'researcher-agent',
    name: 'Researcher',
    provider: EProvider.GOOGLE,
    systemPrompt: 'You are the Researcher Agent.',
    models: ['gemini-3.7-flash'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['search_web'],
  })

  const clientWith = (generateContentStream: TStream, onModel?: (params: ModelParams) => void): GoogleGenerativeAI =>
    ({
      getGenerativeModel: (params: ModelParams) => {
        onModel?.(params)
        return { generateContentStream }
      },
    }) as unknown as GoogleGenerativeAI

  const chunk = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] })

  const drain = async (events: AsyncIterable<IAgentEvent>): Promise<IAgentEvent[]> => {
    const collected: IAgentEvent[] = []
    for await (const event of events) collected.push(event)
    return collected
  }

  it('creates a chat session on the chat lane', async () => {
    const adapter = new GoogleChatAdapter({ client: clientWith(async () => ({ stream: [], response: {} })) })
    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })

    assert.ok(session.id.startsWith('google-chat-'))
    assert.strictEqual(session.mode, EMode.CHAT)
  })

  it('streams text and usage without sending tools', async () => {
    let modelParams: ModelParams | undefined

    const adapter = new GoogleChatAdapter({
      client: clientWith(
        async () => {
          return {
            stream: (async function* () {
              yield chunk('Hello')
              yield chunk(' world')
            })(),
            response: Promise.resolve({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } }),
          }
        },
        (params) => {
          modelParams = params
        },
      ),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }))

    const text = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => e.payload.text)
      .join('')

    assert.strictEqual(text, 'Hello world')
    assert.ok(events.find((e) => e.type === 'usage' && e.payload.inputTokens === 3))
    assert.strictEqual(events[events.length - 1].type, 'message.completed')
    assert.strictEqual(modelParams?.tools, undefined)
  })

  it('sends the system prompt only through systemInstruction', async () => {
    let sent: GenerateContentRequest | undefined
    let modelParams: ModelParams | undefined

    const adapter = new GoogleChatAdapter({
      client: clientWith(
        async (request) => {
          sent = request
          return {
            stream: (async function* () {
              yield chunk('ok')
            })(),
            response: Promise.resolve({}),
          }
        },
        (params) => {
          modelParams = params
        },
      ),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }))

    // O adapter anterior mandava o prompt duas vezes: aqui ele só aparece em systemInstruction.
    assert.strictEqual(modelParams?.systemInstruction, 'You are the Researcher Agent.')
    assert.strictEqual(sent?.contents.length, 1)
    assert.strictEqual(sent?.contents[0].role, 'user')
  })

  it('warns that this SDK has no thinking control', async () => {
    const adapter = new GoogleChatAdapter({
      client: clientWith(async () => ({
        stream: (async function* () {
          yield chunk('ok')
        })(),
        response: Promise.resolve({}),
      })),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent', reasoning: 'high' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }))

    assert.ok(events.find((e) => e.type === 'warning' && e.payload.message.includes('thinking control')))
  })

  it('passes the abort signal on the call, not on the model', async () => {
    let seenSignal: AbortSignal | undefined

    const adapter = new GoogleChatAdapter({
      client: clientWith(async (_request, options) => {
        seenSignal = options?.signal
        return {
          stream: (async function* () {
            yield chunk('partial')
            if (options?.signal?.aborted) throw new Error('aborted')
            yield chunk('never')
          })(),
          response: Promise.resolve({}),
        }
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'Hi' })) {
      events.push(event)
      if (event.type === 'text.delta') await adapter.cancel(session.id)
    }

    assert.ok(seenSignal instanceof AbortSignal)
    assert.strictEqual(events[events.length - 1].type, 'message.aborted')
  })

  it('surfaces provider failures as a normalized error event', async () => {
    const adapter = new GoogleChatAdapter({
      client: clientWith(async () => {
        throw new Error('API down')
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: 'researcher-agent' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }))
    const error = events.find((e) => e.type === 'error')

    assert.ok(error && error.type === 'error')
    assert.strictEqual(error.payload.message, 'API down')
  })
})
