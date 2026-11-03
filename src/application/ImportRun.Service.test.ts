import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IImportTurnResult, importRunMessage, ImportRunService } from './ImportRun.Service'

/** Um turno que só acaba quando o teste manda. */
function deferred() {
  let finish!: (result: IImportTurnResult) => void
  let fail!: (error: Error) => void
  const promise = new Promise<IImportTurnResult>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  return { promise, finish, fail }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('ImportRunService', () => {
  function setup() {
    const turns = new Map<string, ReturnType<typeof deferred>>()
    const messages = new Map<string, string>()
    const service = new ImportRunService({
      prepareTurn: (conversationId, message) => {
        messages.set(conversationId, message)
        return () => {
          const turn = deferred()
          turns.set(conversationId, turn)
          return turn.promise
        }
      },
      now: () => new Date('2026-11-02T10:00:00.000Z'),
    })
    return { service, turns, messages }
  }

  it('roda no máximo `concurrency` de cada vez; o próximo entra quando um acaba', async () => {
    const { service, turns } = setup()
    const queued = service.start(
      [
        { conversationId: 'a', keys: ['spec:a'] },
        { conversationId: 'b', keys: ['spec:b'] },
        { conversationId: 'c', keys: ['spec:c'] },
        { conversationId: 'vazia', keys: [] },
      ],
      2,
    )
    assert.deepStrictEqual(queued, ['a', 'b', 'c'])
    await tick()
    assert.deepStrictEqual(
      Object.entries(service.statusOf(['a', 'b', 'c', 'vazia'])).map(([id, run]) => [id, run.state]),
      [
        ['a', 'running'],
        ['b', 'running'],
        ['c', 'queued'],
      ],
    )
    turns.get('a')!.finish({ status: 'ok' })
    await tick()
    await tick()
    assert.strictEqual(service.statusOf(['a'])['a'].state, 'ok')
    assert.strictEqual(service.statusOf(['c'])['c'].state, 'running')
    turns.get('b')!.finish({ status: 'error', error: 'cota esgotada' })
    turns.get('c')!.fail(new Error('conversa ocupada'))
    await tick()
    await tick()
    assert.deepStrictEqual(service.statusOf(['b'])['b'], { state: 'error', error: 'cota esgotada', at: '2026-11-02T10:00:00.000Z' })
    assert.deepStrictEqual(service.statusOf(['c'])['c'].error, 'conversa ocupada')
  })

  it('a conversa na fila ou rodando não entra de novo; a que acabou pode ser retomada', async () => {
    const { service, turns } = setup()
    service.start([{ conversationId: 'a', keys: ['spec:a'] }], 1)
    await tick()
    assert.deepStrictEqual(service.start([{ conversationId: 'a', keys: ['spec:a'] }]), [])
    turns.get('a')!.finish({ status: 'aborted' })
    await tick()
    await tick()
    assert.deepStrictEqual(service.start([{ conversationId: 'a', keys: ['spec:a'] }]), ['a'])
  })

  it('a mensagem pede o rascunho de cada item sem esperar resposta', () => {
    const { service, messages } = setup()
    service.start([{ conversationId: 'a', keys: ['spec:a', 'spec:b'] }], 9)
    assert.strictEqual(messages.get('a'), importRunMessage(['spec:a', 'spec:b']))
    assert.match(importRunMessage(['spec:a', 'spec:b']), /estes 2 itens .*spec:a, spec:b.*não espere resposta/)
  })
})
