import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IUsageRow } from '@domain/models/Usage.Model'
import { usageDays, UsageService } from './Usage.Service'

const row = (over: Partial<IUsageRow>): IUsageRow => ({
  day: '2026-10-22',
  conversationId: 'c1',
  agentId: 'a1',
  provider: 'claude',
  model: 'claude-sonnet-5',
  turns: 1,
  usage: { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 },
  ...over,
})

const PRICING = { 'claude-sonnet-5': { input: 3, output: 15 } }

describe('UsageService', () => {
  const service = new UsageService()

  it('totais, dias (inclusive os sem uso), agente e modelo batem com as linhas; conversa conta uma vez', () => {
    const rows = [row({}), row({ day: '2026-10-21', turns: 2 }), row({ conversationId: 'c2', agentId: 'a2', model: 'outro' })]
    const summary = service.summarize(rows, { days: ['2026-10-20', '2026-10-21', '2026-10-22'] })

    assert.deepStrictEqual([summary.totals.conversations, summary.totals.turns, summary.totals.usage.totalTokens], [2, 4, 3_300_000])
    assert.deepStrictEqual(
      summary.daily.map((day) => [day.date, day.usage.totalTokens]),
      [
        ['2026-10-20', 0],
        ['2026-10-21', 1_100_000],
        ['2026-10-22', 2_200_000],
      ],
    )
    assert.deepStrictEqual(
      summary.byAgent.map((agent) => [agent.agentId, agent.conversations]),
      [
        ['a1', 1],
        ['a2', 1],
      ],
    )
    assert.strictEqual(summary.top[0].id, 'c1')
  })

  it('⛔ sem preço, nenhum campo de custo; com preço, custo por linha e piso quando falta preço', () => {
    const rows = [row({}), row({ conversationId: 'c2', model: 'sem-preco' })]

    assert.ok(!JSON.stringify(service.summarize(rows, { days: [] })).includes('cost'))

    const priced = service.summarize(rows, { days: [] }, () => PRICING)
    assert.deepStrictEqual([priced.totals.costUsd, priced.totals.costIsFloor], [4.5, true])
    assert.deepStrictEqual(
      priced.byModel.map((model) => [model.model, model.costUsd, model.costIsFloor]),
      [
        ['claude-sonnet-5', 4.5, undefined],
        ['sem-preco', 0, true],
      ],
    )
  })

  it('por usuário: do que mais custou ao que menos; as sem dono numa linha só', () => {
    const rows = [
      row({ ownerId: 'ana', ownerEmail: 'ana@x.test' }),
      row({ conversationId: 'c2', ownerId: 'bia', usage: { inputTokens: 2_000_000, totalTokens: 2_000_000 } }),
      row({ conversationId: 'c3' }),
    ]

    assert.deepStrictEqual(
      service.byUser(rows, () => PRICING).map((user) => [user.ownerId, user.email, user.costUsd]),
      [
        ['bia', undefined, 6],
        ['ana', 'ana@x.test', 4.5],
        [undefined, undefined, 4.5],
      ],
    )
  })

  it('os dias são cortados no fuso de quem pergunta', () => {
    const now = new Date('2026-10-22T01:00:00Z') // 22h do dia 21 em São Paulo
    assert.deepStrictEqual(usageDays(new Date('2026-10-20T03:00:00Z'), now, -180), ['2026-10-20', '2026-10-21'])
  })
})
