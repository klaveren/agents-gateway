import assert from 'node:assert'
import { describe, it } from 'node:test'
import { AgentDeltaTooLargeError, AgentListDeltaError, applyListDelta, isListDelta, resolveAgentPatchDelta } from './AgentPatchDelta.Policy'

const AGENT = { allowedTools: ['a', 'b', 'c'], modes: ['agent'] }

describe('AgentPatchDelta.Policy', () => {
  it('isListDelta: só { add?, remove? } de textos', () => {
    assert.ok(isListDelta({ add: ['x'] }))
    assert.ok(isListDelta({ remove: [] }))
    for (const value of [['x'], {}, { add: 'x' }, { add: ['x'], other: [] }, null, { add: [1] }]) assert.ok(!isListDelta(value), JSON.stringify(value))
  })

  it('applyListDelta: contra a lista de agora; o que já está ou não está não conta', () => {
    const { next, change } = applyListDelta('allowedTools', AGENT.allowedTools, { add: ['b', 'd'], remove: ['a', 'z'] })
    assert.deepStrictEqual(next, ['b', 'c', 'd'])
    assert.deepStrictEqual(change, { field: 'allowedTools', added: ['d'], removed: ['a'], ignored: ['z'] })
    assert.throws(() => applyListDelta('allowedTools', [], { add: ['x'], remove: ['x'] }), AgentListDeltaError)
  })

  it('⛔ lista inteira: recusa com as listas de agora; a igual à de agora sai do patch', () => {
    assert.throws(
      () => resolveAgentPatchDelta(AGENT, { allowedTools: ['a'] }),
      (error: unknown) => error instanceof AgentListDeltaError && error.field === 'allowedTools' && JSON.stringify(error.current) === JSON.stringify(AGENT),
    )
    assert.deepStrictEqual(resolveAgentPatchDelta(AGENT, { allowedTools: ['c', 'a', 'b'], name: 'X' }).patch, { name: 'X' })
  })

  it('delta vira a lista nova; o que não muda sai do patch', () => {
    const resolved = resolveAgentPatchDelta(AGENT, { allowedTools: { add: ['d'], remove: ['b'] }, modes: { add: ['agent'] } })
    assert.deepStrictEqual(resolved.patch, { allowedTools: ['a', 'c', 'd'] })
    assert.deepStrictEqual(
      resolved.changes.map((change) => [change.field, change.added, change.removed]),
      [
        ['allowedTools', ['d'], ['b']],
        ['modes', [], []],
      ],
    )
  })

  it('⛔ teto de 5 (somando campos): 409 com a diferença', () => {
    assert.throws(
      () => resolveAgentPatchDelta(AGENT, { allowedTools: { add: ['d', 'e', 'f'], remove: ['a', 'b'] }, modes: { add: ['chat'] } }),
      (error: unknown) => error instanceof AgentDeltaTooLargeError && error.count === 6 && error.changes.length === 2,
    )
    assert.doesNotThrow(() => resolveAgentPatchDelta(AGENT, { allowedTools: { add: ['d', 'e', 'f'], remove: ['a', 'b'] } }))
  })

  it('creating (agente novo): a lista que só acrescenta vale, sem teto; a que tira, não', () => {
    const empty = { allowedTools: [], modes: ['agent'] }
    const many = ['1', '2', '3', '4', '5', '6']
    assert.deepStrictEqual(resolveAgentPatchDelta(empty, { allowedTools: many }, { creating: true }).patch, { allowedTools: many })
    assert.throws(() => resolveAgentPatchDelta(AGENT, { allowedTools: ['a'] }, { creating: true }), AgentListDeltaError)
  })

  it('normalize: o id antigo vale como o novo (sem contar como mudança)', () => {
    const resolved = resolveAgentPatchDelta(
      { allowedTools: ['cap:terminal'] },
      { allowedTools: { add: ['run_bash'] } },
      { normalize: { allowedTools: (items) => items.map((item) => (item === 'run_bash' ? 'cap:terminal' : item)) } },
    )
    assert.deepStrictEqual([resolved.patch, resolved.changes[0].added], [{}, []])
  })
})
