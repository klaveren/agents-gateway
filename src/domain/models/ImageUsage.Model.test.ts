import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IImageUsageEntry, IMAGE_USAGE_AGENT_ID, imageUsageRows } from './ImageUsage.Model'
import { costOf } from './Model.Pricing'

const entry = (over: Partial<IImageUsageEntry> = {}): IImageUsageEntry => ({
  at: new Date('2026-11-10T01:00:00Z'),
  userId: 'u_ana',
  projectId: 'logiccus',
  agentId: 'atena',
  provider: 'openai',
  model: 'gpt-image-1',
  inputTokens: 10,
  outputTokens: 1000,
  totalTokens: 1010,
  ...over,
})
const query = (over = {}) => ({ since: new Date('2026-11-01T00:00:00Z'), tzOffsetMinutes: 0, ...over })

describe('ImageUsage.Model (a imagem nos relatórios de uso)', () => {
  it('soma por dia, pessoa, agente, projeto e modelo; sob o agente que pediu; sem agente, "Imagens"', () => {
    const rows = imageUsageRows([entry(), entry(), entry({ agentId: undefined })], query({ groupBy: 'project' }))
    assert.equal(rows.length, 2)
    assert.deepEqual([rows[0]!.agentId, rows[0]!.conversationId, rows[0]!.group, rows[0]!.turns, rows[0]!.title], ['atena', 'image:u_ana', 'logiccus', 2, 'Imagens'])
    assert.deepEqual([rows[0]!.usage.inputTokens, rows[0]!.usage.outputTokens, rows[0]!.usage.totalTokens], [20, 2000, 2020])
    assert.equal(rows[1]!.agentId, IMAGE_USAGE_AGENT_ID)
  })

  it('respeita o período, o dono e o filtro de projeto', () => {
    assert.equal(imageUsageRows([entry()], query({ since: new Date('2026-11-11T00:00:00Z') })).length, 0)
    assert.equal(imageUsageRows([entry()], query({ owner: { id: 'u_bia' } })).length, 0)
    assert.equal(imageUsageRows([entry()], query({ owner: null })).length, 0)
    assert.equal(imageUsageRows([entry()], query({ metadata: { project: 'logiccus' } })).length, 1)
    assert.equal(imageUsageRows([entry()], query({ metadata: { project: 'outro' } })).length, 0)
  })

  it('o custo sai do preço do catálogo, na leitura', () => {
    const [row] = imageUsageRows([entry()], query())
    // US$ 5 por milhão na entrada e US$ 40 por milhão na saída.
    const cost = costOf(row!.model, row!.usage, { 'gpt-image-1': { input: 5, output: 40 } })
    assert.ok(Math.abs((cost ?? 0) - (10 * 5 + 1000 * 40) / 1_000_000) < 1e-12)
  })
})
