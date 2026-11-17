import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HostApprovalsService } from './HostApprovals.Service'

const input = { sessionId: 's1', agentId: 'zeus', command: 'sudo brew services restart redis', reason: 'privilege escalation', password: true }

describe('HostApprovalsService', () => {
  it('🖥️ o pedido espera a pessoa; aprovado leva a senha; some da lista ao responder', async () => {
    const service = new HostApprovalsService(60_000)
    const waiting = service.request(input)
    const [open] = service.pending('s1')
    assert.equal(open!.command, input.command)
    assert.deepEqual(service.pending('outra'), [])
    assert.equal(service.answer('outra', open!.id, { approved: true, password: 'x' }), false, 'de outra conversa, não')
    assert.equal(service.answer('s1', open!.id, { approved: true, password: 'segredo', by: 'ana@x.test' }), true)
    assert.deepEqual(await waiting, { approved: true, password: 'segredo', by: 'ana@x.test' })
    assert.deepEqual(service.pending('s1'), [])
    assert.equal(service.answer('s1', open!.id, { approved: true }), false, 'respondido não volta')
  })

  it('⛔ recusado não leva a senha; o prazo e o fim do turno recusam sozinhos', async () => {
    const service = new HostApprovalsService(20)
    const refused = service.request(input)
    service.answer('s1', service.pending('s1')[0]!.id, { approved: false, password: 'vazou?' })
    assert.deepEqual(await refused, { approved: false })
    assert.deepEqual(await service.request(input), { approved: false })
    const controller = new AbortController()
    const aborted = new HostApprovalsService(60_000).request(input, controller.signal)
    controller.abort()
    assert.deepEqual(await aborted, { approved: false })
  })
})
