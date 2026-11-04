import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { applyPanelOp, emptyPanel, IConversationPanel } from '@domain/models/ConversationPanel.Model'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SessionStore } from '@infra/session/Session.Store'
import { adapterKey, AgentProvider } from './Agent.Provider'

/** O painel da conversa no turno: a rota na entrada do modelo e o aviso quando o agente não o atualizou. */
describe('AgentProvider — painel da conversa', () => {
  it('⚖️ a rota entra no começo do turno (só para o modelo); turno que não mexeu no painel deixa o aviso para o próximo', async () => {
    const agent: IAgent = { id: 'maya', name: 'Maya', providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }], systemPrompt: 'p', modes: [EMode.CHAT], allowedTools: [] }
    const store = new SessionStore()
    const seen: Array<{ text: string; tools: string[] }> = []
    let touchPanel = false
    const adapter: IAgentAdapter = {
      async createSession(created, input) {
        const record = store.create({
          agentId: created.id,
          provider: input.provider!,
          protocol: EProvider.CLAUDE,
          mode: EMode.CHAT,
          model: input.model!,
          tools: false,
          systemPrompt: input.systemPrompt ?? 'p',
        })
        return { id: record.id, provider: EProvider.CLAUDE, mode: record.mode, createdAt: record.createdAt }
      },
      async *sendMessage(running, sessionId, input): AsyncIterable<IAgentEvent> {
        seen.push({ text: input.text, tools: running.allowedTools })
        if (touchPanel) yield { type: 'tool.started', sessionId, timestamp: new Date(), payload: { tool: 'conversation_panel', args: { op: 'add' } } }
        yield { type: 'message.completed', sessionId, timestamp: new Date() }
      },
      async cancel() {},
    }
    let panel: IConversationPanel = applyPanelOp(emptyPanel(), { op: 'add', title: 'Migrar os ledgers', status: 'doing' }, { by: 'maya', now: new Date() }).panel
    const provider = new AgentProvider(
      new Map([[adapterKey(EProvider.CLAUDE, EMode.CHAT), adapter]]),
      store,
      new NullSettingsRepository({ audience: 'all' }),
      { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) },
      {
        list: () => [],
        get: (id) => (id === 'claude' ? { id, name: id, protocol: EProvider.CLAUDE, official: true, enabled: true, createdAt: new Date(), updatedAt: new Date() } : undefined),
        connection: (id) => (id === 'claude' ? { providerId: id, name: id, protocol: EProvider.CLAUDE, key: 'k' } : undefined),
      },
    )
    provider.usePanels({ get: async () => panel })
    await new Promise((resolve) => setImmediate(resolve))
    const session = await provider.createSession({ agentId: 'maya' })
    const run = async (text: string) => {
      for await (const _event of provider.sendMessage(session.id, { text })) void _event
    }

    await run('migre os ledgers')
    assert.match(seen[0].text, /<painel da conversa>[\s\S]*Em andamento:\n- p1 Migrar os ledgers[\s\S]*migre os ledgers$/)
    assert.ok(seen[0].tools.includes('conversation_panel'), 'a ferramenta vai em todo agente')
    // O turno não mexeu no painel: o próximo começa com o aviso.
    await run('e as specs?')
    assert.match(seen[1].text, /não entrou no painel/)
    touchPanel = true
    panel = emptyPanel()
    await run('obrigado')
    assert.match(seen[2].text, /não entrou no painel/)
    await run('mais uma')
    assert.doesNotMatch(seen[3].text, /não entrou no painel/, 'o turno anterior mexeu no painel')
    assert.ok(!seen[3].text.includes('<painel da conversa>'), 'painel vazio não entra')
  })
})
