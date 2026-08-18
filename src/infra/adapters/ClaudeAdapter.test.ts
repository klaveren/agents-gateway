import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { ClaudeAdapter } from './ClaudeAdapter'
import { IAgent } from '@domain/models/Agent'
import { EProvider } from '@domain/enums/EProvider'

describe('ClaudeAdapter', () => {
  const getMockMcpClient = () =>
    ({
      getTools: async () => [{ name: 'run_bash', description: 'Run bash', inputSchema: {} }],
      invokeTool: async () => 'tool executed',
    }) as any

  const getAgent = (): IAgent => ({
    id: 'sysops-agent',
    name: 'SysOps',
    provider: EProvider.CLAUDE,
    systemPrompt: 'System prompt here',
    models: [],
    allowedTools: ['run_bash'],
  })

  it('should initialize session and store reasoning/language', async () => {
    const adapter = new ClaudeAdapter(getMockMcpClient())

    const session = await adapter.createSession(getAgent(), {
      agentId: 'sysops-agent',
      model: 'claude-sonnet-5',
      reasoning: 'xhigh',
      language: 'English',
    })

    assert.ok(session.id.startsWith('claude-sess-'))
    assert.strictEqual(session.provider, EProvider.CLAUDE)

    const language = (adapter as any).sessionLanguage.get(session.id)
    assert.strictEqual(language, 'English')

    const reasoning = (adapter as any).sessionReasoning.get(session.id)
    assert.strictEqual(reasoning, 'xhigh')
  })

  it('should stream message and handle tool calls', async () => {
    const mcpClient = getMockMcpClient()
    let invoked = false
    mcpClient.invokeTool = async () => {
      invoked = true
      return 'tool executed'
    }

    const adapter = new ClaudeAdapter(mcpClient)
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops', reasoning: 'high' })

    const mockCreate = mock.fn(async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Thinking...' } }
      yield { type: 'content_block_start', content_block: { type: 'tool_use', id: 'call_1', name: 'run_bash' } }
      yield { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"cmd"' } }
      yield { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: ':"ls"}' } }
    })

    const mockCreateSecond = mock.fn(async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done!' } }
    })

    let iteration = 0
    ;(adapter as any).client = {
      messages: {
        create: async () => {
          if (iteration === 0) {
            iteration++
            return mockCreate() as any
          } else {
            return mockCreateSecond() as any
          }
        },
      },
    }

    const input = {
      text: 'Hello',
      files: [
        { name: 'file.png', mimeType: 'image/png', data: 'b64' },
        { name: 'file.pdf', mimeType: 'application/pdf', data: 'pdf_b64' },
      ],
    }
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
    const adapter = new ClaudeAdapter(getMockMcpClient())
    const session = await adapter.createSession(getAgent(), { agentId: 'sysops' })

    ;(adapter as any).client = {
      messages: {
        create: async () => {
          throw new Error('API down')
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
    const adapter = new ClaudeAdapter(getMockMcpClient())
    const session = await adapter.createSession(getAgent(), { agentId: 'a' })

    assert.ok((adapter as any).history.has(session.id))
    await adapter.cancel(session.id)
    assert.strictEqual((adapter as any).history.has(session.id), false)
  })
})
