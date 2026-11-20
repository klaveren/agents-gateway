import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IUsageRow } from '@domain/models/Usage.Model'
import { imageUsageRows } from '@domain/models/ImageUsage.Model'
import { speechUsageRows } from '@domain/models/SpeechUsage.Model'
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

  it('modelo sem preço: o custo vira piso (marcado), e os tokens contam igual', async () => {
    const service = new UsageCapService(
      async () => [row('ana', 1_000, 0), { ...row('ana', 500, 0), model: 'sem-preco' }],
      () => pricing,
      () => new Date('2026-11-09T12:00:00Z'),
      () => ({ monthlyCostUsd: 1 }),
    )
    const status = await service.status('ana')
    assert.deepStrictEqual([status.gateway.tokens, status.gateway.costIsFloor], [1_500, true])
  })

  it('o teto do gateway em US$ recusa todo mundo; as linhas do mês ficam em cache entre os turnos', async () => {
    const { service, reads } = build({ monthlyCostUsd: 1 }, [row('ana', 600_000, 400_000)])
    assert.match((await service.refusal('bia')) ?? '', /^O gateway atingiu o teto de uso do mês \(US\$ 1\)/)
    await service.refusal('ana')
    assert.strictEqual(reads(), 1)
  })
})

describe('UsageCapService — 💰 o teto do projeto e a chave do projeto', () => {
  const at = (ownerId: string, tokens: number, project: string, provider = 'p'): IUsageRow => ({
    ...row(ownerId, tokens, 0),
    conversationId: `c-${ownerId}-${tokens}-${provider}`,
    group: project,
    provider,
  })
  const build = (caps: object, rows: IUsageRow[], projectCaps: Record<string, { monthlyTokens?: number; monthlyCostUsd?: number }>) =>
    new UsageCapService(
      async (query) => (assert.strictEqual(query.groupBy, 'project'), rows),
      () => pricing,
      () => new Date('2026-11-09T12:00:00Z'),
      () => caps,
      { projectCaps: (id) => projectCaps[id], providerProject: (provider) => (provider === 'alfa--openai' ? 'alfa' : undefined) },
    )

  it('o teto do projeto conta todas as conversas dele (qualquer chave) e recusa só nele', async () => {
    const service = build({}, [at('ana', 600_000, 'alfa'), at('bia', 500_000, 'alfa', 'alfa--openai'), at('caio', 5_000_000, 'beta')], { alfa: { monthlyTokens: 1_000_000 } })
    assert.match((await service.refusal('ana', 'alfa'))!, /O projeto atingiu o teto de uso do mês \(1\.000\.000 tokens\).*Projeto → Modelos/)
    assert.strictEqual(await service.refusal('caio', 'beta'), undefined, 'beta sem teto')
    assert.strictEqual(await service.refusal('ana'), undefined, 'conversa sem projeto')
  })

  it('⚖️ o gasto com a chave de um projeto não conta no teto do gateway', async () => {
    const service = build({ monthlyTokens: 1_000_000 }, [at('ana', 600_000, 'alfa'), at('bia', 900_000, 'alfa', 'alfa--openai')], {})
    const status = await service.status('ana', undefined, 'alfa')
    assert.strictEqual(status.gateway.tokens, 600_000)
    assert.strictEqual(status.reached, undefined)
  })

  it('🎞️ a voz e as imagens (as linhas de mídia) contam nos tokens da pessoa', async () => {
    const query = { since: new Date('2026-11-01T00:00:00Z'), tzOffsetMinutes: 0 }
    const at = new Date('2026-11-05T12:00:00Z')
    const media = { at, provider: 'p', model: 'm', projectId: undefined }
    const rows = [
      row('ana', 500, 0),
      ...speechUsageRows([{ ...media, userId: 'ana', inputTokens: 100, outputTokens: 200, totalTokens: 300, characters: 50 }], query),
      ...imageUsageRows([{ ...media, userId: 'ana', agentId: 'atena', inputTokens: 10, outputTokens: 1_000, totalTokens: 1_010 }], query),
    ]
    const service = new UsageCapService(
      async () => rows,
      () => pricing,
      () => new Date('2026-11-09T12:00:00Z'),
      () => ({ userMonthlyTokens: 1_500 }),
    )
    const status = await service.status('ana')
    assert.strictEqual(status.user?.tokens, 500 + 300 + 1_010)
    assert.match((await service.refusal('ana')) ?? '', /Você atingiu o teto de uso do mês/)
  })
})
