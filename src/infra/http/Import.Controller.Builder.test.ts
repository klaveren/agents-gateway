import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { ImportBuildService } from '@application/ImportBuild.Service'
import { ImportJobService } from '@application/ImportJob.Service'
import { ImportRunService } from '@application/ImportRun.Service'
import { AsyncResource } from 'node:async_hooks'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { maskText } from '@domain/Secret.Mask'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { readRepoFile, readRepoTree } from '@infra/import/Repo.Tree'
import { caller, identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteImportRepository } from '@infra/persistence/Sqlite.ImportRepository'
import { resolveWorkFolder } from '@infra/workspace/Work.Folder'
import { gitInit, writeFixture } from '../../testing/Import.Fixture'
import { ImportController } from './Import.Controller'

/** As rotas do construtor em modo importação: abrir a conversa do lote, aprovar e pedir ajuste — só admin. */
describe('construtor em modo importação (/projects/:id/import/jobs/:job/builder, items/approve, items/adjust)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const MEMBER = token('u_ana', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const base = mkdtempSync(join(tmpdir(), 'gw-import-builder-route-'))
  const folderOf = (projectId: string) => join(base, projectId)
  const repository = new SqliteImportRepository()
  const opened: Array<{ agentId: string; owner?: Record<string, string> }> = []
  let build: ImportBuildService
  let controller: ImportController
  let controllerDeps: () => ConstructorParameters<typeof ImportController>[0]
  let jobId: string

  before(() => {
    const root = join(folderOf('alfa'), 'repositories', 'app')
    mkdirSync(root, { recursive: true })
    writeFixture(root, join(base, 'fora'))
    gitInit(root)
    const mask = { mask: (text: string) => maskText(text, []) }
    const scan = new ImportScanUseCase({
      readTree: (projectId, name) => readRepoTree(resolveWorkFolder(folderOf(projectId), name).dir, mask),
      detectors: [new AgentsDirDetector()],
      findInCatalog: () => undefined,
    })
    const jobs = new ImportJobService({ repository, scan: (projectId, name, options) => scan.execute(projectId, name, options) })
    build = new ImportBuildService({
      repository,
      readSource: (projectId, name, path) => readRepoFile(resolveWorkFolder(folderOf(projectId), name).dir, path, mask),
      openConversation: async (input) => {
        opened.push({ agentId: input.agentId, ...(input.owner ? { owner: input.owner } : {}) })
        return `conv-${opened.length}`
      },
    })
    controllerDeps = () => ({ scan, jobs, build, projectExists: (projectId: string) => projectId === 'alfa', proof })
    controller = new ImportController(controllerDeps())
    jobId = jobs.create('alfa', 'app', 'u_root').id
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  type THandler = 'openBuilder' | 'approveItem' | 'adjustItem' | 'getJob' | 'getItems' | 'prepareBatch' | 'batchConversations'
  const call = (as: string, body: unknown, handler: THandler, target: ImportController = controller, params: Record<string, string> = {}) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: { status: number; body?: { ok: boolean; result?: any; code?: string; details?: any } } = { status: 0 } // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = {
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: typeof reply.body) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      // No GET, a mesma entrada vale como query.
      await target[handler]({ params: { id: 'alfa', job: jobId, ...params }, body, query: body ?? {} } as unknown as Request, res)
      return reply
    })

  it('⛔ quem não é admin recebe 404 em todas, e nada muda', async () => {
    assert.strictEqual((await call(MEMBER, { keys: ['spec:config'] }, 'openBuilder')).status, 404)
    assert.strictEqual((await call(MEMBER, { key: 'spec:config', removals: [] }, 'approveItem')).status, 404)
    assert.strictEqual((await call(MEMBER, { key: 'spec:config', comment: 'x' }, 'adjustItem')).status, 404)
    assert.deepStrictEqual(opened, [])
    assert.strictEqual(repository.item(jobId, 'spec:config')!.state, 'pending')
  })

  it('o admin abre UMA conversa para o lote: o construtor do tipo em modo importação, com ele como dono', async () => {
    const reply = await call(ADMIN, { keys: ['spec:config', 'spec:arquitetura'] }, 'openBuilder')
    assert.strictEqual(reply.status, 200)
    assert.deepStrictEqual(reply.body?.result, { conversationId: 'conv-1', kind: 'spec', agentId: 'builder-import-spec', keys: ['spec:config', 'spec:arquitetura'] })
    assert.deepStrictEqual(opened[0], { agentId: 'builder-import-spec', owner: { id: 'u_root', email: 'u_root@x.test' } })
    assert.deepStrictEqual(
      ['spec:config', 'spec:arquitetura'].map((key) => [repository.item(jobId, key)!.state, repository.item(jobId, key)!.conversationId]),
      [
        ['drafting', 'conv-1'],
        ['drafting', 'conv-1'],
      ],
    )
  })

  it('lote que mistura construtores é 422; sem chaves, 422', async () => {
    const mixed = await call(ADMIN, { keys: ['spec:filas', 'skill:revisar'] }, 'openBuilder')
    assert.deepStrictEqual([mixed.status, mixed.body?.details?.[0]?.field], [422, 'keys'])
    assert.strictEqual((await call(ADMIN, { keys: [] }, 'openBuilder')).status, 422)
    assert.strictEqual((await call(ADMIN, {}, 'openBuilder')).status, 422)
    const batch = await call(ADMIN, { batchId: 'nao-existe' }, 'openBuilder')
    assert.deepStrictEqual([batch.status, batch.body?.details?.[0]?.field], [422, 'batchId'])
  })

  it('⛔ aprovar sem OK de remoção é 422; com OK, 200 e approved; o aprovado não volta ao construtor (409)', async () => {
    build.propose('conv-1', 'spec:config', { id: 'config', title: 'Config', summary: 'A configuração.' }, [
      { op: 'remove', text: '# Config\n', reason: 'título duplicado do sistema antigo' },
    ])
    const missing = await call(ADMIN, { key: 'spec:config', removals: [] }, 'approveItem')
    assert.deepStrictEqual([missing.status, missing.body?.details?.[0]?.field], [422, 'removals'])
    const approved = await call(ADMIN, { key: 'spec:config', removals: [0] }, 'approveItem')
    assert.deepStrictEqual([approved.status, approved.body?.result.state, approved.body?.result.approvedBy], [200, 'approved', 'u_root@x.test'])
    assert.strictEqual((await call(ADMIN, { keys: ['spec:config'] }, 'openBuilder')).status, 409)
  })

  it('pedir ajuste: 200 e o item volta a drafting; sem rascunho a revisar, 409', async () => {
    build.propose('conv-1', 'spec:arquitetura', { id: 'arquitetura', title: 'Arquitetura', summary: 'As camadas.' }, [])
    const adjusted = await call(ADMIN, { key: 'spec:arquitetura', comment: 'divida em duas' }, 'adjustItem')
    assert.deepStrictEqual([adjusted.status, adjusted.body?.result.state, adjusted.body?.result.review.adjust.comment], [200, 'drafting', 'divida em duas'])
    assert.strictEqual((await call(ADMIN, { key: 'spec:arquitetura', comment: 'de novo' }, 'adjustItem')).status, 409)
  })

  it('o estado de alguns itens (o painel ao lado da conversa): só os pedidos, sem o inventário, e a conversa perdida marcada', async () => {
    const some = await call(ADMIN, { keys: ['spec:config', 'spec:arquitetura', 'spec:nao-existe'] }, 'getItems')
    const states = some.body?.result.states as Array<{ key: string; state: string; drafts?: unknown[]; approvedBy?: string; item?: unknown; conversationLost?: boolean }>
    assert.deepStrictEqual(
      [some.status, some.body?.result.latest, some.body?.result.scan, states.map((state) => [state.key, state.state])],
      [
        200,
        true,
        undefined,
        [
          ['spec:config', 'approved'],
          ['spec:arquitetura', 'drafting'],
        ],
      ],
    )
    assert.deepStrictEqual([states[0].approvedBy, states[1].drafts?.length, states[0].item], ['u_root@x.test', 1, undefined])
    // Uma chave só chega como texto.
    assert.deepStrictEqual((await call(ADMIN, { keys: 'spec:config' }, 'getItems')).body?.result.states.length, 1)
    const lost = new ImportController({ ...controllerDeps(), conversationExists: async (id) => id !== 'conv-1' })
    assert.strictEqual((await call(ADMIN, { keys: ['spec:arquitetura'] }, 'getItems', lost)).body?.result.states[0].conversationLost, true)
    assert.strictEqual((await call(ADMIN, {}, 'getItems')).status, 422)
    assert.strictEqual((await call(MEMBER, { keys: ['spec:config'] }, 'getItems')).status, 404)
  })

  it('item no construtor cuja conversa sumiu vem marcado (conversationLost) e abre de novo numa conversa nova', async () => {
    const lost = new ImportController({ ...controllerDeps(), conversationExists: async (id) => id !== 'conv-1' })
    const states = (await call(ADMIN, undefined, 'getJob', lost)).body?.result.states as Array<{ key: string; state: string; conversationLost?: boolean }>
    const of = (key: string) => states.find((state) => state.key === key)!
    assert.deepStrictEqual([of('spec:arquitetura').state, of('spec:arquitetura').conversationLost], ['drafting', true])
    assert.deepStrictEqual([of('spec:config').state, of('spec:config').conversationLost], ['approved', undefined])
    // ⚖️ O trabalho aberto não leva rascunho nem revisão (o peso): só se tem rascunho.
    const raw = of('spec:config') as unknown as Record<string, unknown>
    assert.deepStrictEqual([raw.drafts, raw.review, typeof raw.drafted], [undefined, undefined, 'boolean'])
    // Sem quem confira, nada é marcado.
    assert.strictEqual(
      ((await call(ADMIN, undefined, 'getJob')).body?.result.states as typeof states).some((state) => state.conversationLost),
      false,
    )
    const reopened = await call(ADMIN, { keys: ['spec:arquitetura'] }, 'openBuilder')
    assert.deepStrictEqual([reopened.status, repository.item(jobId, 'spec:arquitetura')!.conversationId], [200, reopened.body?.result.conversationId])
    assert.notStrictEqual(reopened.body?.result.conversationId, 'conv-1')
  })

  it('preparar tudo com `start`: abre o que falta e roda cada conversa no servidor, como quem pediu', async () => {
    repository.createBatch({ id: 'run', jobId, name: 'run', prefix: '', keys: ['skill:revisar'], order: ['skill:revisar'], by: 'u_root', at: new Date('2026-11-02T10:00:00.000Z') })
    const turns: Array<{ conversationId: string; as?: string; message: string }> = []
    const runs = new ImportRunService({
      prepareTurn: (conversationId, message) =>
        AsyncResource.bind(async () => {
          turns.push({ conversationId, as: caller()?.id, message })
          return { status: 'ok' as const }
        }),
    })
    const withRuns = new ImportController({ ...controllerDeps(), runs })
    assert.strictEqual((await call(MEMBER, { start: true }, 'prepareBatch', withRuns, { batch: 'run' })).status, 404)
    assert.strictEqual((await call(ADMIN, { start: true, concurrency: 9 }, 'prepareBatch', withRuns, { batch: 'run' })).status, 422)
    const reply = await call(ADMIN, { start: true, concurrency: 2 }, 'prepareBatch', withRuns, { batch: 'run' })
    assert.strictEqual(reply.status, 200)
    const conversationId = reply.body?.result.conversations[0].conversationId as string
    assert.deepStrictEqual(
      reply.body?.result.runs.map((one: { conversationId: string; pending: string[] }) => [one.conversationId, one.pending]),
      [[conversationId, ['skill:revisar']]],
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepStrictEqual(
      turns.map((one) => [one.conversationId, one.as]),
      [[conversationId, 'u_root']],
    )
    assert.match(turns[0].message, /skill:revisar/)
    const listed = await call(ADMIN, undefined, 'batchConversations', withRuns, { batch: 'run' })
    assert.strictEqual(listed.body?.result.runs[0].run.state, 'ok')
    // De novo, com a conversa já aberta: nada a abrir não é erro, e ela roda outra vez (ainda deve o rascunho).
    const again = await call(ADMIN, { start: true }, 'prepareBatch', withRuns, { batch: 'run' })
    assert.deepStrictEqual([again.status, again.body?.result.conversations], [200, []])
    // Sem o `start`, o mesmo de antes: nada mais vai ao construtor.
    assert.strictEqual((await call(ADMIN, {}, 'prepareBatch', withRuns, { batch: 'run' })).status, 422)
  })

  it('sem o construtor configurado na rota, 404', async () => {
    const bare = new ImportController({ scan: undefined as never, projectExists: () => true, proof })
    assert.strictEqual((await call(ADMIN, { keys: ['spec:filas'] }, 'openBuilder', bare)).status, 404)
  })
})
