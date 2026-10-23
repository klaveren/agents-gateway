import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { protocolCatalog } from './Protocol.Catalog'
import { REASONING_LEVELS } from './Reasoning.Levels'

describe('protocolCatalog', () => {
  it('um item por protocolo, com as regras do domínio', () => {
    const catalog = protocolCatalog()

    assert.deepStrictEqual(
      catalog.map((protocol) => protocol.id),
      Object.values(EProvider),
    )
    for (const protocol of catalog) assert.deepStrictEqual(protocol.reasoningLevels, REASONING_LEVELS[protocol.id])
  })

  it('assinatura: só a lane agent, sem console nem variável; oficial com os dois', () => {
    const byId = Object.fromEntries(protocolCatalog().map((protocol) => [protocol.id, protocol]))

    assert.deepStrictEqual(byId['claude-sub'], { ...byId['claude-sub'], subscription: true, lanes: [EMode.AGENT], nativeFamily: EProvider.CLAUDE, brand: EProvider.CLAUDE })
    assert.strictEqual(byId['claude-sub'].consoleUrl, undefined)
    assert.strictEqual(byId.codex.brand, EProvider.OPENAI)
    assert.deepStrictEqual(byId.openai.lanes, [EMode.CHAT, EMode.AGENT])
    assert.strictEqual(byId.openai.envName, 'OPENAI_API_KEY')
    assert.match(byId.google.consoleUrl ?? '', /^https:\/\/aistudio\.google\.com/)
  })
})
