import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProjectConnectionError } from '@domain/errors/Domain.Error'
import type { IPersonThread } from '@domain/models/PersonMessage.Model'
import { IRemoteCatalog, IRemoteEventHandlers, RemoteRequestError, RemoteUnavailableError } from '@domain/ports/RemoteCatalog.Port'
import { SqliteProjectConnectionRepository } from '@infra/persistence/Sqlite.ProjectConnectionRepository'
import { ProjectConnectionService, TRemoteMessagesEvent } from './ProjectConnection.Service'

const thread = (id: string, over: Partial<IPersonThread> = {}): IPersonThread => ({
  id,
  requestId: id,
  conversationId: 'c1',
  agentId: 'maya',
  projectId: 'logiccus',
  title: 'Aprovar?',
  last: { id, recipientId: 'u1', conversationId: 'c1', agentId: 'maya', from: 'agent', body: 'Posso?', level: 'attention', createdAt: new Date('2026-11-20T10:00:00Z') },
  unread: 1,
  pending: 1,
  archived: false,
  ...over,
})

/** A origem falsa das mensagens: `down` = fora do ar; guarda as chamadas na ordem. */
function origin() {
  const state = { down: false, calls: [] as string[], handlers: undefined as IRemoteEventHandlers | undefined }
  const live = () => {
    if (state.down) throw new RemoteUnavailableError('down')
  }
  const client = {
    version: async () => 1,
    changes: async () => ({ version: 1, changes: [] }),
    events: (handlers: IRemoteEventHandlers, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        state.handlers = handlers
        signal.addEventListener('abort', () => resolve())
      }),
    messages: async (archived?: boolean) => {
      live()
      state.calls.push(`messages:${archived ? 'archived' : 'inbox'}`)
      return { threads: [thread('m_1')], unread: 1, pending: 1 }
    },
    message: async (key: string) => {
      live()
      if (key !== 'm_1') throw new RemoteRequestError(404, 'Not found')
      return { messages: [thread('m_1').last] }
    },
    readMessage: async (key: string) => (live(), state.calls.push(`read:${key}`), { unread: 0 }),
    archiveMessage: async (key: string, archived: boolean) => (live(), state.calls.push(`archive:${key}:${archived}`), { unread: 0 }),
    setMessageStatus: async (key: string, id: string, status: string) => (live(), state.calls.push(`status:${key}:${id}:${status}`), { status, pending: 0 }),
    replyMessage: async (key: string, message: string, replyTo?: string) => (live(), state.calls.push(`reply:${key}:${message}:${replyTo ?? ''}`), { queued: false }),
  } as unknown as IRemoteCatalog
  return { state, client }
}

function build(createdBy = 'ana@x.test') {
  const { state, client } = origin()
  const events: Array<[string, TRemoteMessagesEvent]> = []
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
    onMessages: (projectId, event) => events.push([projectId, event]),
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
      autoUpdate: true,
      createdAt: new Date(),
      createdBy,
    },
    'agc_x',
  )
  return { state, events, service }
}

describe('projeto conectado: as mensagens da origem', () => {
  it('a caixa vem da origem e fica guardada; fora do ar, devolve a última lista marcada como stale', async () => {
    const { state, service } = build()
    const first = await service.remoteMessages('logiccus')
    assert.deepEqual([first.threads.map((item) => item.id), first.unread, first.pending, first.stale], [['m_1'], 1, 1, undefined])
    state.down = true
    const stale = await service.remoteMessages('logiccus')
    assert.deepEqual([stale.threads.map((item) => item.id), stale.stale], [['m_1'], true])
    // As arquivadas nunca vieram: vazia e stale (não inventa).
    const never = await service.remoteMessages('logiccus', true)
    assert.deepEqual([never.threads.length, never.stale], [0, true])
  })

  it('a caixa da conta: só as conexões que ELA fez, cada item com a origem (e stale quando a origem cai)', async () => {
    const { state, service } = build('ana@x.test')
    assert.deepEqual(await service.remoteInbox('bob@x.test'), { threads: [], unread: 0, pending: 0 })
    assert.deepEqual(await service.remoteInbox(undefined), { threads: [], unread: 0, pending: 0 })
    const mine = await service.remoteInbox('ANA@x.test')
    assert.deepEqual(mine.threads[0].origin, { projectId: 'logiccus', url: 'http://origem' })
    assert.equal(mine.unread, 1)
    state.down = true
    assert.deepEqual((await service.remoteInbox('ana@x.test')).threads[0].origin, { projectId: 'logiccus', url: 'http://origem', stale: true })
  })

  it('o item, ler, arquivar, resolver e responder vão à origem; o item que ela não tem não é de ninguém', async () => {
    const { state, service } = build()
    assert.equal((await service.findMessage('ana@x.test', 'm_1'))?.projectId, 'logiccus')
    assert.equal(await service.findMessage('ana@x.test', 'm_9'), undefined)
    assert.equal(await service.findMessage('bob@x.test', 'm_1'), undefined)
    await service.readRemoteMessage('logiccus', 'm_1')
    await service.archiveRemoteMessage('logiccus', 'm_1', true)
    await service.setRemoteMessageStatus('logiccus', 'm_1', 'm_1', 'resolved')
    await service.replyRemoteMessage('logiccus', 'm_1', 'Pode', 'm_1')
    assert.deepEqual(state.calls, ['read:m_1', 'archive:m_1:true', 'status:m_1:m_1:resolved', 'reply:m_1:Pode:m_1'])
  })

  it('origem fora do ar: as ações dão erro claro (unavailable), nunca um 404; a recusa dela passa como é', async () => {
    const { state, service } = build()
    state.down = true
    for (const act of [
      () => service.readRemoteMessage('logiccus', 'm_1'),
      () => service.archiveRemoteMessage('logiccus', 'm_1', true),
      () => service.setRemoteMessageStatus('logiccus', 'm_1', 'm_1', 'pending'),
      () => service.replyRemoteMessage('logiccus', 'm_1', 'oi'),
      () => service.remoteMessage('logiccus', 'm_1'),
      () => service.findMessage('ana@x.test', 'm_1'),
    ])
      await assert.rejects(act(), (error: unknown) => error instanceof ProjectConnectionError && error.reason === 'unavailable')
    state.down = false
    await assert.rejects(service.remoteMessage('logiccus', 'm_9'), (error: unknown) => error instanceof RemoteRequestError && error.status === 404)
  })

  it('o aviso ao vivo da origem chama o gancho: a caixa mudou e a mensagem nova', async () => {
    const { state, events, service } = build()
    service.start()
    try {
      for (let i = 0; i < 20 && !state.handlers; i++) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(state.handlers)
      state.handlers.onMessagesChanged?.({ unread: 2 })
      const message = { id: 'm_2', key: 'm_2', body: 'Oi', level: 'attention' as const, agentId: 'maya', conversationId: 'c1' }
      state.handlers.onMessageNew?.(message)
      assert.deepEqual(events, [
        ['logiccus', { type: 'changed', unread: 2 }],
        ['logiccus', { type: 'new', message }],
      ])
    } finally {
      service.stop()
    }
  })
})
