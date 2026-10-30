import assert from 'node:assert'
import { describe, it } from 'node:test'
import { callSignature } from '@domain/Loop.Policy'
import { makeLocalTools } from './Local.Tools'
import { LoopGuard } from './Loop.Guard'

describe('LoopGuard — o detector de laço', () => {
  const limits = () => ({ refuseAt: 4, stopAt: 6, maxErrors: 8 })

  it('a 4ª chamada idêntica é recusada; a 6ª para o turno; argumentos diferentes contam à parte', () => {
    const guard = new LoopGuard(limits)
    guard.open('s')
    const verdicts = Array.from({ length: 6 }, () => guard.check('s', 'run_bash', { command: 'cat x' }))
    assert.deepStrictEqual(
      verdicts.map((verdict) => !!verdict),
      [false, false, false, true, true, true],
    )
    assert.match(verdicts[3]!, /mesma chamada 3 vezes/)
    assert.match(guard.stopReason('s') ?? '', /run_bash \{"command":"cat x"\} repetido 6 vezes/)
    assert.strictEqual(guard.check('s', 'run_bash', { command: 'cat y' }), undefined)
  })

  it('a chamada vista na execução E no fluxo de eventos conta uma vez só', () => {
    const guard = new LoopGuard(limits)
    guard.open('s')
    for (let index = 0; index < 5; index += 1) {
      guard.observe('s', { type: 'tool.started', tool: 'read_file', args: { path: 'a' } })
      guard.check('s', 'read_file', { path: 'a' })
    }
    assert.strictEqual(guard.stopReason('s'), undefined)
    guard.observe('s', { type: 'tool.started', tool: 'read_file', args: { path: 'a' } })
    assert.match(guard.stopReason('s') ?? '', /repetido 6 vezes/)
  })

  it('8 erros seguidos param o turno; um sucesso no meio zera', () => {
    const guard = new LoopGuard(limits)
    guard.open('s')
    for (let index = 0; index < 7; index += 1) guard.observe('s', { type: 'tool.error' })
    guard.observe('s', { type: 'tool.result' })
    for (let index = 0; index < 7; index += 1) guard.observe('s', { type: 'tool.error' })
    assert.strictEqual(guard.stopReason('s'), undefined)
    guard.observe('s', { type: 'tool.error' })
    assert.match(guard.stopReason('s') ?? '', /8 erros de ferramenta seguidos/)
  })

  it('cada turno começa do zero; fora de um turno aberto não conta nem recusa', () => {
    const guard = new LoopGuard(limits)
    for (let index = 0; index < 5; index += 1) assert.strictEqual(guard.check('s', 't', {}), undefined)
    guard.open('s')
    for (let index = 0; index < 3; index += 1) guard.check('s', 't', {})
    guard.close('s')
    guard.open('s')
    assert.strictEqual(guard.check('s', 't', {}), undefined)
  })

  it('a ordem das chaves não muda a assinatura', () => {
    assert.strictEqual(callSignature('t', { a: 1, b: { c: [1, { d: 2, e: 3 }] } }), callSignature('t', { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }))
  })

  it('⛔ a ferramenta local recusada não roda: o modelo recebe o motivo como erro', async () => {
    let ran = false
    const tools = makeLocalTools({
      loops: { check: (_session, tool) => (tool === 'run_bash' ? 'laço' : undefined) },
      exec: async () => ((ran = true), { stdout: 'x', stderr: '' }),
    })
    const bash = tools.find((tool) => tool.name === 'run_bash')!
    assert.deepStrictEqual(await bash.execute({ command: 'ls' }, { sessionId: 's' }), { status: 'error', result: 'laço' })
    assert.strictEqual(ran, false)
  })
})
