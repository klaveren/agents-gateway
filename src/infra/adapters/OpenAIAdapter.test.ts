import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { OpenAIAdapter } from './OpenAIAdapter'
import { IAgent } from '@domain/models/Agent'
import { EProvider } from '@domain/enums/EProvider'

describe('OpenAIAdapter', () => {
  const getMockMcpClient = () =>
    ({
      getTools: async () => [{ name: 'run_bash', description: 'Run bash', inputSchema: {} }],
      invokeTool: async () => 'tool executed',
    }) as any

  const getAgent = (): IAgent => ({
    id: 'analyst-agent',
    name: 'Data Analyst',
    provider: EProvider.OPENAI,
    systemPrompt: 'System prompt here',
    models: [],
    allowedTools: ['run_bash'],
  })

  it('should initialize session and store reasoning/language', async () => {
    const adapter = new OpenAIAdapter(getMockMcpClient())

    const session = await adapter.createSession(getAgent(), {
      agentId: 'analyst-agent',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      language: 'Portuguese',
    })

    assert.ok(session.id.startsWith('openai-sess-'))
    assert.strictEqual(session.provider, EProvider.OPENAI)

    const history = (adapter as any).history.get(session.id)
    assert.ok(history[0].content.includes('IMPORTANT: Please reply exclusively in Portuguese'))

    const reasoning = (adapter as any).sessionReasoning.get(session.id)
    assert.strictEqual(reasoning, 'high')
  })

  it('should stream message and handle tool calls', async () => {
    const mcpClient = getMockMcpClient()
    let invoked = false
    mcpClient.invokeTool = async () => {
      invoked = true
      return 'tool executed'
    }

    const adapter = new OpenAIAdapter(mcpClient)
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent', reasoning: 'high' })

    // Mock OpenAI client stream
    const mockCreate = mock.fn(async function* () {
      yield { choices: [{ delta: { content: 'Thinking...' } }] }
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_bash', arguments: '{"cmd":"ls"}' } }] } }] }
    })

    // Substituto para segunda iteração após o tool call
    const mockCreateSecond = mock.fn(async function* () {
      yield { choices: [{ delta: { content: 'Done!' } }] }
    })

    let iteration = 0
    ;(adapter as any).client = {
      chat: {
        completions: {
          create: async (config: any) => {
            if (iteration === 0) {
              iteration++
              return mockCreate() as any
            } else {
              return mockCreateSecond() as any
            }
          },
        },
      },
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

  it('should handle API errors and yield error event', async () => {
    const adapter = new OpenAIAdapter(getMockMcpClient())
    const session = await adapter.createSession(getAgent(), { agentId: 'analyst-agent' })

    ;(adapter as any).client = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('API down')
          },
        },
      },
    }

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
    const adapter = new OpenAIAdapter(getMockMcpClient())
    const session = await adapter.createSession(getAgent(), { agentId: 'a' })

    assert.ok((adapter as any).history.has(session.id))
    await adapter.cancel(session.id)
    assert.strictEqual((adapter as any).history.has(session.id), false)
  })
})
