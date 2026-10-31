import { describe, expect, it } from 'vitest'
import { buildLink, builderKindFor, type IImportBuildStatus, importOpening, lastDraft, missingOks, opSummary } from './importDraft'

describe('importDraft', () => {
  it('o construtor de cada tipo: trigger vai ao de agentes; mcp não tem', () => {
    expect([builderKindFor('trigger'), builderKindFor('spec'), builderKindFor('mcp'), builderKindFor('unknown')]).toEqual(['agent', 'spec', undefined, undefined])
  })

  it('o rascunho em vigor é o último; sem operações não é rascunho', () => {
    const status = {
      key: 'k',
      state: 'review',
      fingerprint: 'f',
      drafts: [
        { ops: [], removals: [] },
        { ops: [{ op: 'remove' }], removals: [{ op: 0 }] },
      ],
    } as unknown as IImportBuildStatus
    expect(lastDraft(status)!.ops).toHaveLength(1)
    expect(lastDraft({ ...status, drafts: [{}] })).toBeUndefined()
    expect(missingOks(lastDraft(status)!, new Set())).toEqual([0])
    expect(missingOks(lastDraft(status)!, new Set([0]))).toEqual([])
  })

  it('o resumo de cada operação, o link da conversa e a primeira mensagem', () => {
    expect(opSummary({ op: 'linkCitation', text: 'a/b.md', target: 'b', link: 'reference' })).toBe('a/b.md → b (anexo por referência)')
    expect(opSummary({ op: 'remove', whole: true, source: 'x.md', reason: 'r' })).toBe('a fonte inteira x.md')
    expect(opSummary({ op: 'compose', into: 'soul', sources: ['a.md', 'b.md'] })).toBe('soul ← a.md + b.md')
    expect(buildLink('knowledge', 'c 1')).toBe('/knowledge/build?c=c%201')
    expect(importOpening(['spec:a', 'spec:b'])).toContain('estes 2 itens')
  })
})
