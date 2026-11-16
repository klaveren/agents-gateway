import assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  applyPanelOp,
  emptyPanel,
  freshIds,
  IConversationPanel,
  markAnswersDelivered,
  normalizePanel,
  panelMarkdown,
  panelTurnNote,
  plansMarkdown,
  TPanelOp,
} from './ConversationPanel.Model'
import { planStatusOf } from './ConversationPlan.Model'

const now = new Date('2026-11-16T12:00:00Z')
const agent = { by: 'maya', now, turn: 2 }
const person = { by: 'henrique@x.test', now, actor: 'person' as const }
const apply = (panel: IConversationPanel, op: TPanelOp, context: Parameters<typeof applyPanelOp>[2] = agent) => applyPanelOp(panel, op, context).panel

const draft = () =>
  apply(emptyPanel(), {
    op: 'plan_create',
    title: 'Migrar os ledgers',
    body: '## Contexto\nOs ledgers estão no OpenCode.',
    steps: [{ title: 'Exportar' }, { title: 'Importar', detail: 'pelo Importador' }],
  })

describe('ConversationPlan — o plano da conversa', () => {
  it('cria em rascunho, com ids curtos; vários por conversa', () => {
    const panel = apply(draft(), { op: 'plan_create', title: 'Outro', body: 'b' })
    assert.deepStrictEqual(
      panel.plans.map((plan) => [plan.id, plan.status, plan.version, plan.steps.map((step) => step.id)]),
      [
        ['pl1', 'draft', 1, ['s1', 's2']],
        ['pl2', 'draft', 1, []],
      ],
    )
    assert.strictEqual(panel.items.length, 0, 'o board só recebe os passos na aprovação')
  })

  it('⚖️ aprovado pela pessoa: cada passo vira item do board, ligado ao passo; a decisão vai ao agente UMA vez', () => {
    let panel = apply(draft(), { op: 'plan_submit', id: 'pl1' })
    assert.strictEqual(panel.plans[0].status, 'review')
    panel = apply(panel, { op: 'plan_approve', id: 'pl1' }, person)
    assert.deepStrictEqual(
      panel.items.map((item) => [item.id, item.title, item.status, item.plan]),
      [
        ['p1', 'Exportar', 'queued', { id: 'pl1', step: 's1' }],
        ['p2', 'Importar', 'queued', { id: 'pl1', step: 's2' }],
      ],
    )
    assert.deepStrictEqual(
      panel.plans[0].steps.map((step) => step.item),
      ['p1', 'p2'],
    )
    assert.match(panelTurnNote(panel), /A pessoa APROVOU o plano pl1: os passos estão no board \(p1, p2\)/)
    assert.match(panelTurnNote(panel), /- p1 Exportar \[pl1·s1\]/)
    assert.deepStrictEqual(freshIds(panel), ['pl1'])
    panel = markAnswersDelivered(panel, freshIds(panel))
    assert.doesNotMatch(panelTurnNote(panel), /APROVOU/)
  })

  it('o status do aprovado anda com os itens: algum andando → em execução; todos fechados → concluído', () => {
    let panel = apply(apply(draft(), { op: 'plan_submit', id: 'pl1' }), { op: 'plan_approve', id: 'pl1' }, person)
    const status = () => planStatusOf(panel.plans[0], (id) => panel.items.find((item) => item.id === id)?.status)
    assert.strictEqual(status(), 'approved')
    panel = apply(panel, { op: 'update', id: 'p1', status: 'doing' })
    assert.strictEqual(status(), 'doing')
    panel = apply(apply(panel, { op: 'update', id: 'p1', status: 'done' }), { op: 'update', id: 'p2', status: 'dropped' })
    assert.strictEqual(status(), 'done')
    assert.doesNotMatch(panelTurnNote(panel), /Planos:/, 'plano concluído sai da rota')
  })

  it('ajustes pedidos: vão ao agente com o texto; ele atualiza (versão sobe) e envia de novo', () => {
    let panel = apply(apply(draft(), { op: 'plan_submit', id: 'pl1' }), { op: 'plan_changes', id: 'pl1', text: 'Falta o rollback' }, person)
    assert.strictEqual(panel.plans[0].status, 'changes')
    assert.match(panelTurnNote(panel), /A pessoa pediu AJUSTES no plano pl1: Falta o rollback/)
    panel = apply(panel, { op: 'plan_update', id: 'pl1', steps: [{ title: 'Exportar' }, { title: 'Importar' }, { title: 'Rollback' }] })
    assert.deepStrictEqual([panel.plans[0].version, panel.plans[0].steps.length, panel.plans[0].status], [2, 3, 'changes'])
    panel = apply(panel, { op: 'plan_submit', id: 'pl1' })
    assert.strictEqual(panel.plans[0].status, 'review')
    // Mexer no que está com a pessoa volta a rascunho: a aprovação vale para a versão que ela viu.
    assert.strictEqual(apply(panel, { op: 'plan_update', id: 'pl1', body: 'outro' }).plans[0].status, 'draft')
  })

  it('⛔ o que não serve é recusado com o motivo', () => {
    const approved = apply(apply(draft(), { op: 'plan_submit', id: 'pl1' }), { op: 'plan_approve', id: 'pl1' }, person)
    const refused = (panel: IConversationPanel, op: TPanelOp, context: Parameters<typeof applyPanelOp>[2] = agent) => assert.throws(() => applyPanelOp(panel, op, context))
    refused(draft(), { op: 'plan_approve', id: 'pl1' }) // o agente sem citar a pessoa
    refused(approved, { op: 'plan_update', id: 'pl1', steps: [{ title: 'x' }] }) // passos fixos depois de aprovado
    refused(approved, { op: 'plan_changes', id: 'pl1', text: 'x' }, person)
    refused(apply(emptyPanel(), { op: 'plan_create', title: 't', body: 'b' }), { op: 'plan_submit', id: 'pl1' }) // sem passos
    refused(draft(), { op: 'plan_create', title: '', body: 'b' })
    refused(draft(), { op: 'plan_submit', id: 'pl9' })
    // O agente registra a aprovação que a pessoa deu no chat, citando-a; essa não volta como aviso.
    const inChat = apply(draft(), { op: 'plan_approve', id: 'pl1', note: '"pode seguir"' })
    assert.deepStrictEqual([inChat.plans[0].status, inChat.items.length, freshIds(inChat)], ['approved', 2, []])
  })

  it('o Markdown traz os planos com status e passos; o gravado é lido tolerante', () => {
    const panel = apply(apply(draft(), { op: 'plan_submit', id: 'pl1' }), { op: 'plan_approve', id: 'pl1' }, person)
    assert.match(plansMarkdown(panel, 'pl1'), /^# pl1 · Migrar os ledgers\n\n\*\*Status:\*\* planejado · versão 1[\s\S]*- s1 Exportar → p1 \(queued\)/)
    assert.match(panelMarkdown(panel), /# Planos[\s\S]*## pl1 · Migrar os ledgers/)
    assert.doesNotMatch(panelMarkdown(panel, { plans: false }), /# Planos/)
    assert.throws(() => plansMarkdown(panel, 'pl9'), /plan not found/)
    assert.deepStrictEqual(
      normalizePanel({
        items: [],
        plans: [
          { id: 'pl1', title: 't', status: 'nada' },
          { id: 'pl2', title: 't', status: 'draft' },
        ],
      }).plans.map((plan) => plan.id),
      ['pl2'],
    )
    assert.deepStrictEqual(normalizePanel({ items: [] }).plans, [])
  })
})
