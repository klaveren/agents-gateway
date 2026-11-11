import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IRemoteUsageRow, remoteUsageRows } from './RemoteUsage.Model'

const row: IRemoteUsageRow = {
  key: 'k',
  projectId: 'logiccus',
  userId: 'u_ana',
  email: 'ana@x.test',
  day: '2026-11-10',
  conversationId: 'gw_1',
  agentId: 'maya',
  provider: 'claude',
  model: 'sonnet',
  turns: 1,
  usage: { totalTokens: 10 },
}
const query = (over = {}) => ({ since: new Date('2026-11-01T00:00:00Z'), tzOffsetMinutes: 0, ...over })

describe('RemoteUsage.Model (o uso de lá nos relatórios daqui)', () => {
  it('vira linha daqui, marcada (a conversa de lá não abre aqui) e no dono da conexão', () => {
    const [mapped] = remoteUsageRows([row], query({ groupBy: 'project' }))
    assert.deepEqual([mapped!.conversationId, mapped!.ownerId, mapped!.group, mapped!.title], ['remote:logiccus:gw_1', 'u_ana', 'logiccus', 'conversa no gateway de ana@x.test'])
  })

  it('o recorte: período, dono, só o filtro de projeto (outro filtro a exclui)', () => {
    assert.equal(remoteUsageRows([row], query({ since: new Date('2026-11-11T00:00:00Z') })).length, 0)
    assert.equal(remoteUsageRows([row], query({ owner: { id: 'u_bob' } })).length, 0)
    assert.equal(remoteUsageRows([row], query({ owner: null })).length, 0)
    assert.equal(remoteUsageRows([row], query({ metadata: { project: 'logiccus' } })).length, 1)
    assert.equal(remoteUsageRows([row], query({ metadata: { accountId: 'x' } })).length, 0)
  })
})
