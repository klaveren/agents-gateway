import assert from 'node:assert'
import { describe, it } from 'node:test'
import { applyPanelOp, emptyPanel, freshAnswers, IConversationPanel, markAnswersDelivered, normalizePanel, panelMarkdown, panelTurnNote, TPanelOp } from './ConversationPanel.Model'

const now = new Date('2026-11-04T21:00:00Z')
const run = (panel: IConversationPanel, ...ops: TPanelOp[]) => ops.reduce((current, op, turn) => applyPanelOp(current, op, { turn, by: 'maya', now }).panel, panel)

describe('ConversationPanel.Model', () => {
  it('pedido entra na fila, vai a andamento e a entregue com a nota, os links e o turno; tudo na linha do tempo', () => {
    const panel = run(
      emptyPanel(),
      { op: 'set_goal', goal: 'Migrar o AKM para o gateway' },
      { op: 'add', title: 'Migrar os ledgers' },
      { op: 'update', id: 'p1', status: 'doing' },
      { op: 'update', id: 'p1', status: 'done', note: '8 ledgers, 920 linhas', links: [{ label: 'PR #227', href: 'https://github.com/x/y/pull/227' }] },
    )
    assert.deepStrictEqual(panel.items[0], {
      id: 'p1',
      title: 'Migrar os ledgers',
      status: 'done',
      askedTurn: 1,
      doneTurn: 3,
      note: '8 ledgers, 920 linhas',
      links: [{ label: 'PR #227', href: 'https://github.com/x/y/pull/227' }],
    })
    assert.strictEqual(panel.history.length, 4)
    assert.ok(panel.history.every((event) => event.by === 'maya'))
  })

  it('ids curtos e próprios por tipo; mover reordena; reabrir tira o turno da entrega', () => {
    let panel = run(emptyPanel(), { op: 'add', title: 'a' }, { op: 'add', title: 'b' }, { op: 'decide', text: 'usar grupos' }, { op: 'ask', text: 'Bailian no crítico?' })
    assert.deepStrictEqual([panel.items.map((item) => item.id), panel.decisions[0].id, panel.questions[0].id], [['p1', 'p2'], 'd1', 'q1'])
    panel = run(
      panel,
      { op: 'move', id: 'p2', before: 'p1' },
      { op: 'update', id: 'p1', status: 'done' },
      { op: 'update', id: 'p1', status: 'queued' },
      { op: 'answer', id: 'q1', answer: 'não' },
    )
    assert.deepStrictEqual(
      panel.items.map((item) => item.id),
      ['p2', 'p1'],
    )
    assert.strictEqual(panel.items[1].doneTurn, undefined)
    assert.strictEqual(panel.questions[0].answer, 'não')
  })

  it('⛔ operação ruim é recusada com o motivo, e o painel não muda', () => {
    const panel = run(emptyPanel(), { op: 'add', title: 'a' })
    assert.throws(() => applyPanelOp(panel, { op: 'update', id: 'p9', status: 'done' }, { by: 'x', now }), /item not found: p9/)
    assert.throws(() => applyPanelOp(panel, { op: 'add', title: '  ' }, { by: 'x', now }), /title: required/)
    assert.throws(() => applyPanelOp(panel, { op: 'update', id: 'p1', status: 'feito' as never }, { by: 'x', now }), /status: one of/)
    assert.strictEqual(panel.items[0].status, 'queued')
  })

  it('a nota do turno traz a rota (sem o entregue por extenso) e o aviso quando o turno anterior não atualizou', () => {
    const panel = run(
      emptyPanel(),
      { op: 'set_goal', goal: 'Fechar a migração' },
      { op: 'add', title: 'Ledgers', status: 'done' },
      { op: 'add', title: 'Triggers', status: 'doing', delegatedTo: { agentId: 'agent-god', sessionId: 'gw_1' } },
      { op: 'add', title: 'Specs' },
      { op: 'ask', text: 'Aprovar?' },
    )
    const note = panelTurnNote(panel)
    assert.match(note, /Objetivo: Fechar a migração/)
    assert.match(note, /Em andamento:\n- p2 Triggers \(com agent-god, gw_1\)/)
    assert.match(note, /Na fila:\n- p3 Specs/)
    assert.match(note, /Perguntas para a pessoa \(.*feche com conversation_panel answer\):\n- q1 Aprovar\?/)
    assert.doesNotMatch(note, /Ledgers/)
    assert.match(note, /\(1 entregue;/)
    assert.match(panelTurnNote(panel, true), /não entrou no painel/)
    assert.strictEqual(panelTurnNote(emptyPanel()), '')
    assert.match(panelTurnNote(emptyPanel(), true), /não entrou no painel/)
  })

  it('a resposta da pessoa no painel vai ao agente UMA vez; a do agente, nunca', () => {
    const asked = run(emptyPanel(), { op: 'ask', text: 'Qual porta?' }, { op: 'ask', text: 'Pode subir?' })
    const byPerson = applyPanelOp(asked, { op: 'answer', id: 'q1', answer: '27017' }, { by: 'henrique', now, actor: 'person' }).panel
    const both = applyPanelOp(byPerson, { op: 'answer', id: 'q2', answer: 'sim, no chat' }, { by: 'maya', now }).panel
    assert.deepStrictEqual(
      freshAnswers(both).map((question) => question.id),
      ['q1'],
    )
    assert.match(panelTurnNote(both), /A pessoa respondeu no painel \(considere agora\):\n- q1 Qual porta\? → 27017/)
    assert.doesNotMatch(panelTurnNote(both), /Pode subir/)
    const seen = markAnswersDelivered(both, ['q1'])
    assert.deepStrictEqual(freshAnswers(seen), [])
    assert.doesNotMatch(panelTurnNote(seen), /respondeu no painel/)
  })

  it('o Markdown tem tudo, e o gravado é lido tolerante', () => {
    const panel = run(emptyPanel(), { op: 'add', title: 'Ledgers', status: 'done' }, { op: 'decide', text: 'um pedido por item', why: 'aprovar parte' })
    const markdown = panelMarkdown(panel)
    assert.match(markdown, /## Entregue\n- p1 Ledgers/)
    assert.match(markdown, /## Decisões\n- d1 um pedido por item — aprovar parte/)
    assert.deepStrictEqual(
      normalizePanel({
        items: [
          { id: 'p1', title: 'x', status: 'zzz' },
          { id: 'p2', title: 'y', status: 'queued' },
        ],
      }).items.map((item) => item.id),
      ['p2'],
    )
    assert.deepStrictEqual(normalizePanel('lixo'), emptyPanel())
  })
})
