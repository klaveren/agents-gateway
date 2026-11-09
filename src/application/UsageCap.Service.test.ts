import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IUsageRow } from '@domain/models/Usage.Model'
import { UsageCapService } from './UsageCap.Service'

const row = (ownerId: string, inputTokens: number, outputTokens: number): IUsageRow => ({
  day: '2026-11-02',
  conversationId: `c-${ownerId}-${inputTokens}`,
  ownerId,
  agentId: 'a',
  provider: 'p',
  model: 'm',
  turns: 1,
  usage: { inputTokens, outputTokens },
})
// US$ 1 por milhão de tokens de entrada e de saída.
const pricing = { m: { input: 1, output: 1 } }

describe('UsageCapService', () => {
  const build = (caps: object, rows: IUsageRow[]) => {
    let reads = 0
    const service = new UsageCapService(
      async (query) => {
        reads++
        assert.strictEqual(query.since.toISOString(), '2026-11-01T00:00:00.000Z')
        return rows
      },
      () => pricing,
      () => new Date('2026-11-09T12:00:00Z'),
      () => caps,
    )
    return { service, reads: () => reads }
  }

  it('sem teto, não lê nada e não recusa', async () => {
    const { service, reads } = build({}, [row('ana', 1, 1)])
    assert.strictEqual(await service.refusal('ana'), undefined)
    assert.strictEqual(reads(), 0)
  })

  it('soma o mês do gateway e da pessoa: o teto da pessoa vale só para ela', async () => {
    const { service } = build({ userMonthlyTokens: 1_500 }, [row('ana', 1_000, 600), row('bia', 100, 100)])
    assert.match((await service.refusal('ana')) ?? '', /Você atingiu o teto de uso do mês \(1\.500 tokens\)/)
    assert.strictEqual(await service.refusal('bia'), undefined)
    const status = await service.status('bia')
    assert.strictEqual(status.gateway.tokens, 1_800)
    assert.ok(Math.abs(status.gateway.costUsd - 0.0018) < 1e-12)
    assert.strictEqual(status.user?.tokens, 200)
    assert.ok(Math.abs((status.user?.costUsd ?? 0) - 0.0002) < 1e-12)
  })

  it('o teto do gateway em US$ recusa todo mundo; as linhas do mês ficam em cache entre os turnos', async () => {
    const { service, reads } = build({ monthlyCostUsd: 1 }, [row('ana', 600_000, 400_000)])
    assert.match((await service.refusal('bia')) ?? '', /^O gateway atingiu o teto de uso do mês \(US\$ 1\)/)
    await service.refusal('ana')
    assert.strictEqual(reads(), 1)
  })
})
