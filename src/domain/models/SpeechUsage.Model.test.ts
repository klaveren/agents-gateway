import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { costOf } from './Model.Pricing'
import { ISpeechUsageEntry, SPEECH_USAGE_AGENT_ID, speechUsageRows } from './SpeechUsage.Model'

const entry = (over: Partial<ISpeechUsageEntry> = {}): ISpeechUsageEntry => ({
  at: new Date('2026-11-10T01:00:00Z'),
  userId: 'u_ana',
  projectId: 'logiccus',
  provider: 'bailian',
  model: 'qwen-tts',
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  characters: 40,
  ...over,
})
const query = (over = {}) => ({ since: new Date('2026-11-01T00:00:00Z'), tzOffsetMinutes: 0, ...over })

describe('SpeechUsage.Model (a voz nos relatórios de uso)', () => {
  it('soma por dia, pessoa, projeto e modelo; marcada como "Voz (mensagens)", sem link de conversa', () => {
    const rows = speechUsageRows([entry(), entry(), entry({ projectId: undefined })], query({ groupBy: 'project' }))
    assert.equal(rows.length, 2)
    const [withProject] = rows
    assert.deepEqual(
      [withProject!.agentId, withProject!.title, withProject!.conversationId, withProject!.group, withProject!.turns],
      [SPEECH_USAGE_AGENT_ID, 'Voz (mensagens)', 'speech:u_ana', 'logiccus', 2],
    )
    assert.deepEqual([withProject!.usage.inputTokens, withProject!.usage.outputTokens, withProject!.usage.totalTokens], [20, 40, 60])
    assert.equal(rows[1]!.group, undefined)
  })

  it('o dia segue o fuso de quem pergunta', () => {
    assert.equal(speechUsageRows([entry()], query({ tzOffsetMinutes: -180 }))[0]!.day, '2026-11-09')
  })

  it('o recorte: período, dono, só o filtro de projeto', () => {
    assert.equal(speechUsageRows([entry()], query({ since: new Date('2026-11-11T00:00:00Z') })).length, 0)
    assert.equal(speechUsageRows([entry()], query({ owner: { id: 'u_bob' } })).length, 0)
    assert.equal(speechUsageRows([entry()], query({ owner: null })).length, 0)
    assert.equal(speechUsageRows([entry()], query({ owner: { id: 'u_ana' }, metadata: { project: 'logiccus' } })).length, 1)
    assert.equal(speechUsageRows([entry()], query({ metadata: { project: 'outro' } })).length, 0)
    assert.equal(speechUsageRows([entry()], query({ metadata: { accountId: 'x' } })).length, 0)
  })

  it('💰 o custo sai do preço do modelo no catálogo; sem preço, indefinido (como um modelo de conversa)', () => {
    const [row] = speechUsageRows([entry({ inputTokens: 1_000_000, outputTokens: 1_000_000 })], query())
    assert.equal(costOf(row!.model, row!.usage, { 'qwen-tts': { input: 2, output: 10 } }), 12)
    assert.equal(costOf(row!.model, row!.usage, {}), undefined)
  })
})
