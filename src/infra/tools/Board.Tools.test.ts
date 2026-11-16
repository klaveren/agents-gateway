import assert from 'node:assert'
import { describe, it } from 'node:test'
import { emptyPanel, IConversationPanel } from '@domain/models/ConversationPanel.Model'
import { deprecatedCitedIn, deprecationLine, DEPRECATED_TOOLS } from '@domain/Tool.Deprecations'
import { ambientSection } from '@domain/Ambient.Policy'
import { makeLocalTools } from './Local.Tools'

/** O board, o alias obsoleto e o plano, como o agente os chama. */
describe('board e plan — as ferramentas da conversa', () => {
  const store = () => {
    let panel: IConversationPanel = emptyPanel()
    const tools = makeLocalTools({ panels: { get: async () => panel, save: async (_id, next) => void (panel = next), turnOf: () => 3 } })
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
    return { tool, panel: () => panel }
  }
  const context = { sessionId: 'gw_1', agentId: 'maya' }

  it('`board` grava; o alias `conversation_panel` faz o mesmo e avisa que é obsoleto', async () => {
    const { tool, panel } = store()
    assert.strictEqual((await tool('board').execute({ op: 'add', title: 'Ledgers' }, context)).status, 'success')
    const legacy = await tool('conversation_panel').execute({ op: 'add', title: 'Specs' }, context)
    assert.strictEqual(legacy.status, 'success')
    assert.match(String(legacy.result), /^\[deprecated\] `conversation_panel` is an alias of `board` and will be removed in 1\.0\.0/)
    assert.match(tool('conversation_panel').description, /DEPRECATED alias of `board`/)
    assert.deepStrictEqual(
      panel().items.map((item) => item.title),
      ['Ledgers', 'Specs'],
    )
    assert.strictEqual((await tool('board').execute({ op: 'plan_create', title: 't', body: 'b' }, context)).status, 'error', 'plano é do `plan`')
  })

  it('`plan`: cria, envia, e o agente registra a aprovação dada no chat (citando); os passos entram no board', async () => {
    const { tool, panel } = store()
    const plan = tool('plan')
    const created = await plan.execute({ op: 'create', title: 'Migração', body: '## Contexto\nx', steps: [{ title: 'Exportar' }, { title: 'Importar' }] }, context)
    assert.match(String(created.result), /Saved: plano pl1 criado/)
    assert.strictEqual((await plan.execute({ op: 'submit', id: 'pl1' }, context)).status, 'success')
    assert.strictEqual((await plan.execute({ op: 'approve', id: 'pl1' }, context)).status, 'error', 'sem citar a pessoa')
    assert.strictEqual((await plan.execute({ op: 'approve', id: 'pl1', note: '"pode seguir"' }, context)).status, 'success')
    assert.deepStrictEqual(
      panel().items.map((item) => [item.id, item.plan?.step]),
      [
        ['p1', 's1'],
        ['p2', 's2'],
      ],
    )
    assert.match(String((await plan.execute({ op: 'read', id: 'pl1' }, context)).result), /^# pl1 · Migração/)
    assert.strictEqual((await plan.execute({ op: 'add_steps', id: 'pl1', steps: [{ title: 'Conferir' }], note: 'pedido no chat' }, context)).status, 'success')
    assert.deepStrictEqual(panel().items.at(-1)?.plan, { id: 'pl1', step: 's3' })
    assert.strictEqual((await plan.execute({ op: 'changes', id: 'pl1', text: 'x' }, context)).status, 'error', 'pedir ajustes é da pessoa')
    assert.strictEqual((await plan.execute({ op: 'read' }, { agentId: 'maya' })).status, 'error', 'fora de conversa')
  })
})

describe('Tool.Deprecations — as ferramentas obsoletas', () => {
  it('cada uma diz o substituto e a versão em que sai; o talk de antes está registrado', () => {
    for (const tool of DEPRECATED_TOOLS) assert.ok(tool.replacement && tool.removeIn && tool.since, tool.name)
    assert.deepStrictEqual(
      DEPRECATED_TOOLS.filter((tool) => tool.replacement === 'talk').map((tool) => tool.name),
      ['delegate_to_agent', 'start_conversation', 'send_message', 'get_turn'],
    )
  })

  it('o prompt que cita uma obsoleta de agente ganha a linha no Ambiente; a do MCP não conta', () => {
    const cited = deprecatedCitedIn('Use conversation_panel e delegate_to_agent; send_message também.')
    assert.deepStrictEqual(
      cited.map((tool) => tool.name),
      ['conversation_panel', 'delegate_to_agent'],
    )
    assert.deepStrictEqual(deprecatedCitedIn('my_conversation_panels'), [])
    const ambient = ambientSection({ agentId: 'maya', talk: true, deprecated: cited })
    assert.ok(ambient.includes(deprecationLine(cited[0])))
    assert.match(ambient, /Onde o seu prompt diz `delegate_to_agent`, use `talk` — `delegate_to_agent` está obsoleta e sai na versão 1\.0\.0\./)
  })
})
