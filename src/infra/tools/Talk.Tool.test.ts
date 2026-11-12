import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { DelegationService, IDelegationRequest } from '@application/Delegation.Service'
import { DelegationSlot, makeTalkTool } from './Talk.Tool'

/** Um serviço de delegação de mentira: guarda o que o `talk` pediu e responde o combinado. */
const fakeService = () => {
  const asked: Array<[string, unknown]> = []
  const service = {
    directory: async (allowed: readonly string[]) => (asked.push(['directory', [...allowed]]), { agents: allowed.map((id) => ({ id })), conversations: [] }),
    status: async (_allowed: readonly string[], id: string) => (
      asked.push(['status', id]),
      id === 'gw_1' ? { ok: true, status: { conversation: id, to: 'integra', running: true } } : { ok: false, error: `conversation ${id} was deleted or does not exist` }
    ),
    agentOf: async (id: string) => (id === 'gw_1' ? 'integra' : undefined),
    delegate: async (request: IDelegationRequest) => {
      asked.push(['delegate', request])
      const sessionId = request.sessionId ?? 'nova'
      return request.wait === false
        ? { ok: true, agentId: request.agentId, sessionId, reply: '', pending: true }
        : { ok: true, agentId: request.agentId, sessionId, reply: 'feito' }
    },
  }
  const slot = new DelegationSlot()
  slot.bind(service as unknown as DelegationService)
  return { slot, asked }
}

describe('talk — a ferramenta do agente para falar com outro', () => {
  const context = { sessionId: 'pai' }

  it('sem nada lista com quem falar; com `to` só, só aquele', async () => {
    const { slot, asked } = fakeService()
    const tool = makeTalkTool(['tradutor', 'integra'], slot)
    assert.deepStrictEqual(JSON.parse(String((await tool.execute({}, context)).result)).agents, [{ id: 'tradutor' }, { id: 'integra' }])
    await tool.execute({ to: 'integra' }, context)
    assert.deepStrictEqual(asked, [
      ['directory', ['tradutor', 'integra']],
      ['directory', ['integra']],
    ])
  })

  it('`conversation` sem mensagem é o estado dela; a que não existe vira erro', async () => {
    const { slot } = fakeService()
    const tool = makeTalkTool(['integra'], slot)
    assert.deepStrictEqual(await tool.execute({ conversation: 'gw_1' }, context), {
      status: 'success',
      result: JSON.stringify({ conversation: 'gw_1', to: 'integra', running: true }),
    })
    assert.strictEqual((await tool.execute({ conversation: 'gw_x' }, context)).status, 'error')
  })

  it('fala: `to` abre conversa nova; `conversation` continua, com o agente dela; `wait: 0` não espera', async () => {
    const { slot, asked } = fakeService()
    const tool = makeTalkTool(['integra'], slot)
    assert.deepStrictEqual(JSON.parse(String((await tool.execute({ to: 'integra', message: 'oi' }, context)).result)), { to: 'integra', conversation: 'nova', reply: 'feito' })
    await tool.execute({ conversation: 'gw_1', message: 'de novo' }, context)
    const pending = JSON.parse(String((await tool.execute({ conversation: 'gw_1', message: 'sem esperar', wait: 0 }, context)).result))
    assert.deepStrictEqual([pending.status, pending.conversation], ['pending', 'gw_1'])
    await tool.execute({ to: 'integra', message: 'espera', wait: 30 }, context)
    assert.deepStrictEqual(
      asked.map(([, request]) => request),
      [
        { allowed: ['integra'], agentId: 'integra', message: 'oi' },
        { allowed: ['integra'], agentId: 'integra', message: 'de novo', sessionId: 'gw_1' },
        { allowed: ['integra'], agentId: 'integra', message: 'sem esperar', sessionId: 'gw_1', wait: false },
        { allowed: ['integra'], agentId: 'integra', message: 'espera' },
      ],
    )
  })

  it('⛔ a mensagem sem `to` nem conversa que exista é erro; a regra `delegate` que nega barra antes de falar', async () => {
    const { slot, asked } = fakeService()
    assert.match(String((await makeTalkTool(['integra'], slot).execute({ message: 'oi' }, context)).result), /say who to talk to/)
    assert.match(String((await makeTalkTool(['integra'], slot).execute({ conversation: 'gw_x', message: 'oi' }, context)).result), /does not exist/)
    const denied = makeTalkTool(['integra'], slot, { check: () => ({ allowed: false, reason: 'regra do projeto' }) } as never)
    assert.deepStrictEqual(await denied.execute({ to: 'integra', message: 'oi' }, context), { status: 'error', result: 'Not permitted: regra do projeto' })
    assert.deepStrictEqual(asked, [])
    assert.strictEqual((await makeTalkTool(['integra'], new DelegationSlot()).execute({}, context)).status, 'error')
  })
})
