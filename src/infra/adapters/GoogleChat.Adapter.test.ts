import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { GenerateContentRequest, GoogleGenerativeAI, ModelParams } from '@google/generative-ai'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { GOOGLE_TEST_AGENT } from '../../testing/Agents.Fixture'
import type { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { GoogleChatAdapter, toFunctionDeclaration } from './GoogleChat.Adapter'

interface ISingleRequestOptions {
  signal?: AbortSignal
}
type TStream = (request: GenerateContentRequest, options?: ISingleRequestOptions) => Promise<unknown>

describe('GoogleChatAdapter', () => {
  const getAgent = (): IAgent => ({ ...GOOGLE_TEST_AGENT, providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }] })

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

  it('⛔ a declaração de função sai sem o que a API do Gemini recusa (additionalProperties, em todo nível)', () => {
    const declared = toFunctionDeclaration({
      origin: 'local',
      name: 'run_bash',
      description: 'd',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' }, env: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
        required: ['command'],
        additionalProperties: false,
      },
    })
    assert.ok(!JSON.stringify(declared).includes('additionalProperties'))
    assert.deepStrictEqual((declared.parameters as unknown as { required: string[] }).required, ['command'])
  })

  it('creates a chat session on the chat lane', async () => {
    const adapter = new GoogleChatAdapter({ client: clientWith(async () => ({ stream: [], response: {} })) })
    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })

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

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }, {}))

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

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }, {}))

    // O adapter anterior mandava o prompt duas vezes: aqui ele só aparece em systemInstruction.
    assert.strictEqual(modelParams?.systemInstruction, GOOGLE_TEST_AGENT.systemPrompt)
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

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id, reasoning: 'high' })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }, {}))

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

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events: IAgentEvent[] = []

    for await (const event of adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }, {})) {
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

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }, {}))
    const error = events.find((e) => e.type === 'error')

    assert.ok(error && error.type === 'error')
    assert.strictEqual(error.payload.message, 'API down')
  })

  it('reports the implicit cache as a parcel of the input', async () => {
    const adapter = new GoogleChatAdapter({
      client: clientWith(async () => ({
        stream: (async function* () {
          yield chunk('ok')
        })(),
        response: Promise.resolve({ usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 4, cachedContentTokenCount: 700 } }),
      })),
    })

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }, {}))

    assert.deepStrictEqual(events.find((e) => e.type === 'usage')?.payload, { inputTokens: 1000, contextTokens: 1000, outputTokens: 4, cacheReadTokens: 700, cacheWriteTokens: 0 })
  })

  it('sends an attachment with no text without an empty text part', async () => {
    let sent: GenerateContentRequest | undefined
    const adapter = new GoogleChatAdapter({
      client: clientWith(async (request) => {
        sent = request
        return {
          stream: (async function* () {
            yield chunk('ok')
          })(),
          response: Promise.resolve({}),
        }
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id })
    await drain(adapter.sendMessage(getAgent(), session.id, { text: '', files: [{ name: 'a.png', mimeType: 'image/png', data: 'aaa' }] }, {}))

    assert.deepStrictEqual(sent?.contents[0].parts, [{ inlineData: { data: 'aaa', mimeType: 'image/png' } }])
  })

  it('⛔ devolve ao history as partes do modelo com o thoughtSignature (o Gemini 3 recusa a chamada sem ele)', async () => {
    const requests: GenerateContentRequest[] = []
    const calls = [
      {
        stream: [
          {
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'vou rodar', thoughtSignature: 'sig-text' },
                    { functionCall: { name: 'run_bash', args: { command: 'ls' } }, thoughtSignature: 'sig-call' },
                  ],
                },
              },
            ],
          },
        ],
      },
      { stream: [chunk('pronto')] },
    ]
    const catalog = {
      toolbox: async () => ({
        tools: [{ origin: 'local', name: 'run_bash', description: 'd', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }],
        invoke: async () => ({ status: 'success', result: 'a.txt' }),
      }),
    } as unknown as ToolCatalog

    const adapter = new GoogleChatAdapter({
      catalog,
      client: clientWith(async (request) => {
        // O history é mutado depois da chamada: o teste guarda uma cópia do que foi enviado.
        requests.push(structuredClone(request))
        const next = calls[requests.length - 1]
        return { stream: next.stream, response: Promise.resolve({}) }
      }),
    })

    const session = await adapter.createSession(getAgent(), { agentId: GOOGLE_TEST_AGENT.id, tools: true })
    const events = await drain(adapter.sendMessage(getAgent(), session.id, { text: 'Hi' }, {}))

    assert.strictEqual(events[events.length - 1].type, 'message.completed')
    assert.strictEqual(requests.length, 2)

    const model = requests[1].contents.find((content) => content.role === 'model')
    assert.deepStrictEqual(model?.parts, [
      { text: 'vou rodar', thoughtSignature: 'sig-text' },
      { functionCall: { name: 'run_bash', args: { command: 'ls' } }, thoughtSignature: 'sig-call' },
    ])
  })
})
