import assert from 'node:assert'
import { describe, it } from 'node:test'
import { ruleWidenings, wideningsOf } from './Catalog.Widening'
import { canonicalize, catalogHash, ICatalogDocument } from './Catalog.Document'
import { IPermissionRule } from './Permission.Policy'
import { applyRuleChange, requestStatus, requestWidenings, ruleChangeIssues, rulesHash, splitRuleChange } from './PermissionRequest.Policy'

const allow = (category: IPermissionRule['category'], pattern: string): IPermissionRule => ({ category, pattern, decision: 'allow' })
const deny = (category: IPermissionRule['category'], pattern: string): IPermissionRule => ({ category, pattern, decision: 'deny' })
const theo = { kind: 'agent' as const, id: 'theo', projectId: 'alfa' }

describe('PermissionRequest.Policy — o que restringe vale já, o que amplia fica pendente', () => {
  const current = [allow('terminal', 'git status'), deny('terminal', 'git push *'), allow('read', 'src/**')]

  it('separa: deny novo e allow tirado valem já; allow novo e deny tirado ficam no pedido, com as chaves do catálogo', () => {
    const split = splitRuleChange(theo, current, {
      add: [deny('network', '*.evil.com'), allow('terminal', 'npm test')],
      remove: [allow('read', 'src/**'), deny('terminal', 'git push *')],
    })
    assert.deepStrictEqual(split.immediate, { add: [deny('network', '*.evil.com')], remove: [allow('read', 'src/**')] })
    assert.deepStrictEqual(split.pending, { add: [allow('terminal', 'npm test')], remove: [deny('terminal', 'git push *')] })
    assert.deepStrictEqual(split.rules, [allow('terminal', 'git status'), deny('terminal', 'git push *'), deny('network', '*.evil.com')])
    assert.deepStrictEqual(
      split.widenings.map((item) => item.key),
      ['agent/theo@alfa#permissions+allow:terminal:npm test', 'agent/theo@alfa#permissions-deny:terminal:git push *'],
    )
  })

  it('⚖️ a mesma definição do catálogo: as chaves são as do documento inteiro do agente', () => {
    const after = applyRuleChange(current, { add: [allow('terminal', 'npm test')], remove: [deny('terminal', 'git push *')] })
    const doc = (rules: IPermissionRule[]): ICatalogDocument => {
      const body = { id: 'theo', name: 'Theo', projectId: 'alfa', permissions: rules } as never
      const text = canonicalize(body)
      return { kind: 'agent', id: 'theo', projectId: 'alfa', body, text, hash: catalogHash(text) }
    }
    assert.deepStrictEqual(
      ruleWidenings(theo, current, after).map((item) => item.key),
      wideningsOf(doc(current), doc(after)).map((item) => item.key),
    )
  })

  it('allow já coberto por outro não amplia: vale já, sem pedido', () => {
    const split = splitRuleChange(theo, [allow('terminal', 'git *')], { add: [allow('terminal', 'git status')], remove: [] })
    assert.deepStrictEqual(split.widenings, [])
    assert.deepStrictEqual(split.pending, { add: [], remove: [] })
    assert.deepStrictEqual(split.rules, [allow('terminal', 'git *'), allow('terminal', 'git status')])
  })

  it('⛔ na dúvida, trava: o deny estreito sob um largo que também sai vai junto para o pedido', () => {
    const rules = [deny('terminal', 'git *'), deny('terminal', 'git push *')]
    const split = splitRuleChange(theo, rules, { add: [], remove: [deny('terminal', 'git push *'), deny('terminal', 'git *')] })
    assert.deepStrictEqual(split.immediate, { add: [], remove: [] })
    assert.strictEqual(split.pending.remove.length, 2)
    assert.deepStrictEqual(split.rules, rules)
  })

  it('valida com o validador do formulário (campo a campo), o motivo, a regra a tirar que não existe e o mesmo dos dois lados', () => {
    assert.deepStrictEqual(ruleChangeIssues({ add: [allow('terminal', 'ls')] }, current), [
      { field: 'reason', message: 'required: why the agent needs this (shown to whoever confirms)' },
    ])
    const bad = ruleChangeIssues({ reason: 'x', add: [{ category: 'shell', pattern: '', decision: 'maybe' }, allow('terminal', 'npm **')] }, current)
    assert.deepStrictEqual(
      bad.map((issue) => issue.field),
      ['add[0]', 'add[0]', 'add[0]', 'add[1]'],
    )
    assert.deepStrictEqual(ruleChangeIssues({ reason: 'x' }, current), [{ field: 'add', message: 'send add and/or remove' }])
    assert.deepStrictEqual(
      ruleChangeIssues({ reason: 'x', remove: [allow('read', 'docs/**')] }, current).map((issue) => issue.field),
      ['remove[0]'],
    )
    assert.deepStrictEqual(
      ruleChangeIssues({ reason: 'x', add: [allow('read', 'src/**')], remove: [allow('read', 'src/**')] }, current).map((issue) => issue.field),
      ['add[0]'],
    )
  })

  it('recalcula sobre o agente de agora: a ampliação que outra mudança já cobriu some', () => {
    const request = { add: [allow('terminal', 'npm test')], remove: [] }
    assert.strictEqual(requestWidenings(theo, current, request).length, 1)
    assert.deepStrictEqual(requestWidenings(theo, [...current, allow('terminal', 'npm *')], request), [])
  })

  it('a impressão das regras ignora ordem e nota', () => {
    assert.strictEqual(rulesHash([allow('read', 'a'), deny('read', 'b')]), rulesHash([{ ...deny('read', 'b'), note: 'x' }, allow('read', ' a ')]))
    assert.notStrictEqual(rulesHash([allow('read', 'a')]), rulesHash([deny('read', 'a')]))
  })

  it('vence em 7 dias, calculado na leitura; decidido não vence', () => {
    const createdAt = new Date('2026-11-01T10:00:00Z')
    assert.strictEqual(requestStatus({ status: 'pending', createdAt }, new Date('2026-11-08T09:59:59Z')), 'pending')
    assert.strictEqual(requestStatus({ status: 'pending', createdAt }, new Date('2026-11-08T10:00:00Z')), 'expired')
    assert.strictEqual(requestStatus({ status: 'approved', createdAt }, new Date('2027-01-01T00:00:00Z')), 'approved')
  })
})
