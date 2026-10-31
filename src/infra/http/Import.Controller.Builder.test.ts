import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { ImportBuildService } from '@application/ImportBuild.Service'
import { ImportJobService } from '@application/ImportJob.Service'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { maskText } from '@domain/Secret.Mask'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { readRepoFile, readRepoTree } from '@infra/import/Repo.Tree'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
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
    controller = new ImportController({ scan, jobs, build, projectExists: (projectId) => projectId === 'alfa', proof })
    jobId = jobs.create('alfa', 'app', 'u_root').id
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  type THandler = 'openBuilder' | 'approveItem' | 'adjustItem'
  const call = (as: string, body: unknown, handler: THandler, target: ImportController = controller) =>
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
      await target[handler]({ params: { id: 'alfa', job: jobId }, body } as unknown as Request, res)
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

  it('sem o construtor configurado na rota, 404', async () => {
    const bare = new ImportController({ scan: undefined as never, projectExists: () => true, proof })
    assert.strictEqual((await call(ADMIN, { keys: ['spec:filas'] }, 'openBuilder', bare)).status, 404)
  })
})
