import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InvalidLedgerError, LedgerQueuedError } from '@domain/errors/Domain.Error'
import type { ILedgerWrite } from '@domain/models/Ledger.Model'
import { IRemoteCatalog, RemoteRequestError, RemoteUnavailableError } from '@domain/ports/RemoteCatalog.Port'
import { SqliteProjectConnectionRepository } from '@infra/persistence/Sqlite.ProjectConnectionRepository'
import { ProjectConnectionService } from './ProjectConnection.Service'

/** A origem falsa: guarda as escritas na ordem; `down` = fora do ar; `refuse` = recusa com campos. */
function origin() {
  const state = { down: false, refuse: false, written: [] as Array<{ agentId: string; topic: string; conversationId?: string }> }
  const client: IRemoteCatalog = {
    version: async () => 1,
    changes: async () => ({ version: 1, changes: [] }),
    package: async () => {
      throw new Error('not used')
    },
    file: async () => Buffer.from(''),
    events: async () => undefined,
    ledger: (agentId) => ({
      index: async () => {
        if (state.down) throw new RemoteUnavailableError('down')
        return { index: { agentId, contexts: [], lineCount: state.written.length, warnings: [] }, prompt: `## Ledger de ${agentId}` }
      },
      context: async () => ({}),
      search: async () => ({}),
      write: async (change: ILedgerWrite, conversationId?: string) => {
        if (state.down) throw new RemoteUnavailableError('down')
        if (state.refuse) throw new RemoteRequestError(422, 'Ledger change is invalid', [{ field: 'trigger', message: 'too short' }])
        state.written.push({ agentId, topic: change.topic, ...(conversationId ? { conversationId } : {}) })
        return { action: change.action, topic: change.topic, changed: true }
      },
    }),
  }
  return { state, client }
}

function build() {
  const { state, client } = origin()
  const repository = new SqliteProjectConnectionRepository(':memory:')
  const service = new ProjectConnectionService({
    repository,
    box: { seal: (plain) => plain, open: (box) => box },
    client: () => client,
    projects: { exists: () => false, create: () => undefined },
    files: { has: () => true, put: () => ({ sha256: '' }) },
    applier: {} as never,
    reader: { list: () => [] },
    remove: async () => undefined,
    models: async () => ({ enabled: () => true }),
  })
  repository.insert(
    {
      projectId: 'logiccus',
      url: 'http://origem',
      remoteProjectId: 'logiccus',
      syncedVersion: 1,
      latestVersion: 1,
      state: 'ok',
      changes: [],
      skipped: [],
      secrets: [],
      modelMap: {},
      createdAt: new Date(),
      createdBy: 'dev',
    },
    'agc_x',
  )
  return { state, service, repository }
}

const change = (topic: string): ILedgerWrite => ({ action: 'criar', topic, trigger: 'quando acontecer de novo no CI' })

describe('projeto conectado: o ledger mora na origem', () => {
  it('ler vai à origem e guarda; com ela fora do ar, devolve a última leitura (e o prompt também)', async () => {
    const { state, service } = build()
    const first = await service.ledgerRead<{ index: { lineCount: number } }>('logiccus', 'maya', 'index')
    assert.equal(first.index.lineCount, 0)
    assert.equal(service.ledgerPrompt('logiccus', 'maya'), '## Ledger de maya')
    state.down = true
    assert.deepEqual(await service.ledgerRead('logiccus', 'maya', 'index'), first)
    await assert.rejects(service.ledgerRead('logiccus', 'outro', 'index'), /não respondeu/)
  })

  it('escrever com a origem fora do ar entra na FILA, na ordem; a próxima conferência esvazia', async () => {
    const { state, service, repository } = build()
    state.down = true
    await assert.rejects(service.ledgerWrite('logiccus', 'maya', change('um'), 'gw_1'), LedgerQueuedError)
    state.down = false
    // Com fila, a nova entra atrás dela (a fila sai antes): a ordem fica.
    await service.ledgerWrite('logiccus', 'maya', change('dois'), 'gw_2')
    assert.deepEqual(
      state.written.map((entry) => entry.topic),
      ['um', 'dois'],
    )
    assert.equal(repository.pendingLedger('logiccus').length, 0)

    state.down = true
    await assert.rejects(service.ledgerWrite('logiccus', 'maya', change('tres')), LedgerQueuedError)
    state.down = false
    await service.check('logiccus')
    assert.deepEqual(state.written.at(-1), { agentId: 'maya', topic: 'tres' })
  })

  it('a recusa da origem volta com os campos; na fila, sai da fila e fica anotada na conexão', async () => {
    const { state, service, repository } = build()
    state.refuse = true
    await assert.rejects(service.ledgerWrite('logiccus', 'maya', change('ruim')), InvalidLedgerError)
    state.down = true
    await assert.rejects(service.ledgerWrite('logiccus', 'maya', change('ruim-na-fila')), LedgerQueuedError)
    state.down = false
    await service.flushLedger('logiccus')
    assert.equal(repository.pendingLedger('logiccus').length, 0)
    assert.match(repository.get('logiccus')!.skipped.at(-1)!.message, /recusou/)
  })
})
