import assert from 'node:assert'
import { describe, it } from 'node:test'
import { canReclassify, canTransition, carryOver, countByState, IMPORT_TRANSITIONS, reuseSummary, sourceFingerprint } from './Import.Job'
import { IMPORT_ITEM_STATES } from './models/ImportJob.Model'

const source = (path: string, sha: string) => ({ path, aliases: [], bytes: 1, tokens: 1, sha256: sha.repeat(64) })

describe('Import.Job', () => {
  it('o resumo das fontes muda com o conteúdo, com fonte nova ou sumida; não com a ordem nem com o alias', () => {
    const base = sourceFingerprint({ sources: [source('a.md', 'a'), source('b.md', 'b')] })
    assert.strictEqual(sourceFingerprint({ sources: [source('b.md', 'b'), source('a.md', 'a')] }), base)
    assert.strictEqual(sourceFingerprint({ sources: [{ ...source('a.md', 'a'), aliases: ['x/a.md'] }, source('b.md', 'b')] }), base)
    assert.notStrictEqual(sourceFingerprint({ sources: [source('a.md', 'a'), source('b.md', 'c')] }), base)
    assert.notStrictEqual(sourceFingerprint({ sources: [source('a.md', 'a')] }), base)
    assert.notStrictEqual(sourceFingerprint({ sources: [source('a.md', 'a'), source('b.md', 'b'), source('c.md', 'c')] }), base)
  })

  it('toda transição leva a um estado conhecido; aplicado só sai pela reanálise; excluir e incluir', () => {
    for (const [from, targets] of Object.entries(IMPORT_TRANSITIONS)) {
      assert.ok(IMPORT_ITEM_STATES.includes(from as never))
      for (const to of targets) assert.ok(IMPORT_ITEM_STATES.includes(to), `${from} → ${to}`)
    }
    assert.deepStrictEqual(IMPORT_TRANSITIONS.applied, [])
    assert.ok(canTransition('pending', 'skipped'))
    assert.ok(canTransition('skipped', 'pending'))
    assert.ok(canTransition('stale', 'skipped'))
    assert.ok(!canTransition('approved', 'skipped'))
    assert.ok(!canTransition('drafting', 'skipped'))
    assert.ok(!canTransition('pending', 'approved'))
  })

  it('reclassificar só sem rascunho no caminho', () => {
    for (const state of ['pending', 'skipped', 'rejected', 'error', 'stale'] as const) assert.ok(canReclassify(state), state)
    for (const state of ['drafting', 'review', 'approved', 'applied'] as const) assert.ok(!canReclassify(state), state)
  })

  describe('carryOver', () => {
    it('item novo nasce pendente', () => {
      assert.deepStrictEqual(carryOver(undefined, 'f1'), { outcome: 'added', state: 'pending' })
    })

    it('pendente continua pendente, mude a fonte ou não', () => {
      assert.deepStrictEqual(carryOver({ state: 'pending', fingerprint: 'f1' }, 'f2'), { outcome: 'kept', state: 'pending' })
    })

    it('fonte igual à da decisão mantém o estado', () => {
      for (const state of ['skipped', 'approved', 'rejected', 'review', 'applied'] as const)
        assert.deepStrictEqual(carryOver({ state, fingerprint: 'f1', basis: 'f1' }, 'f1'), { outcome: 'kept', state })
    })

    it('fonte mudada depois da decisão vira stale, lembrando o estado de antes', () => {
      assert.deepStrictEqual(carryOver({ state: 'approved', fingerprint: 'f1', basis: 'f1' }, 'f2'), { outcome: 'stale', state: 'stale', staleFrom: 'approved' })
      // Sem base gravada, a base é a fonte do próprio trabalho.
      assert.deepStrictEqual(carryOver({ state: 'skipped', fingerprint: 'f1' }, 'f2'), { outcome: 'stale', state: 'stale', staleFrom: 'skipped' })
    })

    it('⚖️ compara com a fonte DA DECISÃO: duas reanálises com a fonte mudada não limpam a marca; a fonte de volta à da decisão desfaz', () => {
      const stale = { state: 'stale' as const, staleFrom: 'approved' as const, fingerprint: 'f2', basis: 'f1' }
      assert.deepStrictEqual(carryOver(stale, 'f2'), { outcome: 'stale', state: 'stale', staleFrom: 'approved' })
      assert.deepStrictEqual(carryOver(stale, 'f3'), { outcome: 'stale', state: 'stale', staleFrom: 'approved' })
      assert.deepStrictEqual(carryOver(stale, 'f1'), { outcome: 'restored', state: 'approved' })
    })
  })

  it('o resumo da reanálise e a contagem por estado', () => {
    const summary = reuseSummary(
      'j1',
      [
        { key: 'a', outcome: 'kept' },
        { key: 'b', outcome: 'stale' },
        { key: 'c', outcome: 'added' },
        { key: 'd', outcome: 'kept' },
      ],
      ['e'],
    )
    assert.deepStrictEqual(summary, { from: 'j1', kept: 2, stale: ['b'], restored: [], added: ['c'], gone: ['e'] })
    assert.deepStrictEqual(countByState([{ state: 'pending' }, { state: 'pending' }, { state: 'stale' }]), { pending: 2, stale: 1 })
  })
})
