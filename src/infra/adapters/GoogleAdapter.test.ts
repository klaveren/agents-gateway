import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { GoogleAdapter } from './GoogleAdapter'
import { IAgent } from '@domain/models/Agent'
import { EProvider } from '@domain/enums/EProvider'

describe('GoogleAdapter', () => {
  const getMockMcpClient = () =>
    ({
      getTools: async () => [{ name: 'run_bash', description: 'Run bash', inputSchema: {} }],
      invokeTool: async () => 'tool executed',
    }) as any

  const getAgent = (): IAgent => ({
    id: 'researcher-agent',
    name: 'Researcher',
    provider: EProvider.GOOGLE,
    systemPrompt: 'System prompt here',
    models: [],
    allowedTools: ['run_bash'],
  })

  it('should initialize session and store reasoning/language', async () => {
    const adapter = new GoogleAdapter(getMockMcpClient())

    const session = await adapter.createSession(getAgent(), {
      agentId: 'researcher-agent',
      model: 'gemini-3.7-flash',
      reasoning: 'medium',
      language: 'Spanish',
    })

    assert.ok(session.id.startsWith('google-sess-'))
    assert.strictEqual(session.provider, EProvider.GOOGLE)

    const history = (adapter as any).history.get(session.id)
    assert.ok(history[0].parts[0].text.includes('IMPORTANT: Please reply exclusively in Spanish'))

    const reasoning = (adapter as any).sessionReasoning.get(session.id)
    assert.strictEqual(reasoning, 'medium')
  })

  it('should stream message and handle tool calls', async () => {
    const mcpClient = getMockMcpClient()
    let invoked = false
    mcpClient.invokeTool = async () => {
      invoked = true
      return 'tool executed'
    }

    const adapter = new GoogleAdapter(mcpClient)
    const session = await adapter.createSession(getAgent(), { agentId: 'r' })

    const mockStreamFirst = mock.fn(async function* () {
      yield {
        text: () => 'Thinking...',
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'run_bash', args: { cmd: 'ls' } } }],
            },
          },
        ],
      }
    })

    const mockStreamSecond = mock.fn(async function* () {
      yield {
        text: () => 'Done!',
        candidates: [{ content: { parts: [{ text: 'Done!' }] } }],
      }
    })

    let iteration = 0
    const mockModel = {
      startChat: () => ({}),
      generateContentStream: async () => {
        if (iteration === 0) {
          iteration++
          return { stream: mockStreamFirst() }
        } else {
          return { stream: mockStreamSecond() }
        }
      },
    }

    ;(adapter as any).client = {
      getGenerativeModel: () => mockModel,
    }

    const input = { text: 'Hello', files: [{ name: 'file.png', mimeType: 'image/png', data: 'b64' }] }
    const iterator = adapter.sendMessage(getAgent(), session.id, input)
    const events = []
    for await (const event of iterator) {
      events.push(event)
    }

    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Thinking...'))
    assert.ok(events.find((e) => e.type === 'tool.started' && e.payload.tool === 'run_bash'))
    assert.ok(events.find((e) => e.type === 'tool.result' && e.payload.result === 'tool executed'))
    assert.ok(events.find((e) => e.type === 'text.delta' && e.payload.text === 'Done!'))
    assert.strictEqual(invoked, true)
  })

  it('should handle chunk.text() throwing error without crashing stream', async () => {
    const mcpClient = getMockMcpClient()
    const adapter = new GoogleAdapter(mcpClient)
    const session = await adapter.createSession(getAgent(), { agentId: 'r' })

    const mockStreamFirst = mock.fn(async function* () {
      yield {
        text: () => {
          throw new Error('No text available')
        },
        candidates: [
          {
            content: {
              parts: [
                { text: 'Hidden text' }, // Simulate weird chunk without text() but with parts
              ],
            },
          },
        ],
      }
    })

    const mockModel = {
      startChat: () => ({}),
      generateContentStream: async () => ({ stream: mockStreamFirst() }),
    }

    ;(adapter as any).client = { getGenerativeModel: () => mockModel }

    const iterator = adapter.sendMessage(getAgent(), session.id, { text: 'Hi' })
    const events = []
    for await (const event of iterator) {
      events.push(event)
    }

    // Nenhuma exceção deve ser lançada pelo throw do chunk.text() e o stream deve terminar
    assert.ok(events.find((e) => e.type === 'message.completed'))
  })

  it('should handle API errors and yield error event', async () => {
    const adapter = new GoogleAdapter(getMockMcpClient())
    const session = await adapter.createSession(getAgent(), { agentId: 'r' })

    const mockModel = {
      startChat: () => ({}),
      generateContentStream: async () => {
        throw new Error('API down')
      },
    }

    ;(adapter as any).client = { getGenerativeModel: () => mockModel }

    const iterator = adapter.sendMessage(getAgent(), session.id, { text: 'Hello' })
    const events = []
    for await (const event of iterator) {
      events.push(event)
    }

    const errEvent = events.find((e) => e.type === 'error')
    assert.ok(errEvent)
    assert.strictEqual((errEvent.payload as { error: string }).error, 'API down')
  })

  it('should cancel a session', async () => {
    const adapter = new GoogleAdapter(getMockMcpClient())
    const session = await adapter.createSession(getAgent(), { agentId: 'a' })

    assert.ok((adapter as any).history.has(session.id))
    await adapter.cancel(session.id)
    assert.strictEqual((adapter as any).history.has(session.id), false)
  })
})
