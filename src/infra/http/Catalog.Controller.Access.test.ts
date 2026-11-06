import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { CatalogHistoryQuery } from '@application/CatalogHistory.Query'
import type { CatalogExportUseCase } from '@application/CatalogExport.Usecase'
import type { CatalogImportApplier } from '@application/CatalogImport.Apply'
import type { CatalogImportPlanner } from '@application/CatalogImport.Plan'
import type { CatalogRestoreUseCase } from '@application/CatalogRestore.Usecase'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteCatalogHistoryRepository } from '@infra/persistence/Sqlite.CatalogHistoryRepository'
import { CatalogController } from './Catalog.Controller'
import { useProjectAccess } from './Project.Access'

/**
 * ⛔ O isolamento por projeto (ver `Project.Access`): a Ana administra `alfa`, a Bia administra `beta`, o Caio é membro
 * de `alfa`, o root administra o gateway e não é membro de projeto nenhum.
 */
describe('Catalog: o admin do projeto, só o projeto dele', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ROOT = token('u_root', 'admin')
  const ANA = token('u_ana', 'member')
  const BIA = token('u_bia', 'member')
  const CAIO = token('u_caio', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, Record<string, 'admin' | 'member'>> = { alfa: { u_ana: 'admin', u_caio: 'member' }, beta: { u_bia: 'admin' } }
  before(() =>
    useProjectAccess({
      roles: {
        exists: (id) => id in members,
        roleOf: (id, userId) => (userId ? members[id]?.[userId] : undefined),
        projectsOf: (userId) => Object.keys(members).filter((id) => members[id]![userId]),
      },
    }),
  )
  after(() => useProjectAccess(undefined))

  const repository = new SqliteCatalogHistoryRepository(':memory:')
  const append = (kind: 'mcp' | 'agent' | 'rule', itemId: string, projectId: string | undefined, at: string) =>
    repository.append({
      kind,
      itemId,
      ...(projectId ? { projectId } : {}),
      op: 'create',
      document: `{"id":"${itemId}"}`,
      hash: itemId.padEnd(64, '0'),
      at: new Date(at),
      by: 'root',
      source: 'api',
    })
  append('mcp', 'alfa.n8n', 'alfa', '2026-10-30T10:00:00Z')
  append('mcp', 'beta.n8n', 'beta', '2026-10-30T11:00:00Z')
  append('agent', 'theo', 'alfa', '2026-10-30T12:00:00Z')
  append('rule', 'r-global', undefined, '2026-10-30T13:00:00Z')
  const batch = (id: string, scope: string, projectId: string | undefined) => {
    repository.createBatch({ id, at: new Date('2026-10-31T10:00:00Z'), by: 'root', kind: 'import', scope, summary: { itens: ['segredo'] }, widenings: [], status: 'applied' })
    repository.append({
      kind: 'rule',
      itemId: `r-${id}`,
      ...(projectId ? { projectId } : {}),
      op: 'create',
      document: '{}',
      hash: id.padEnd(64, '0'),
      at: new Date('2026-10-31T10:00:00Z'),
      by: 'root',
      source: 'import',
      batchId: id,
    })
  }
  batch('lote-alfa', 'project:alfa', 'alfa')
  batch('lote-beta', 'project:beta', 'beta')
  batch('lote-global', 'global', undefined)

  const writes: string[] = []
  /** Quem pede, como o caso de uso recebe (a trava de `sharedWith` pergunta a ele o que se administra). */
  let lastCaller: { by?: string; administers?: (projectId: string) => boolean } | undefined
  const planned: unknown[] = []
  const controller = new CatalogController({
    history: new CatalogHistoryQuery(repository, { read: () => undefined }),
    proof,
    projects: { canUse: (caller, projectId) => !!caller.userId && !!members[projectId]?.[caller.userId] },
    batches: repository,
    restore: {
      restore: async (request: { item: { itemId: string } }, caller: { by: string }) => (
        (lastCaller = caller),
        writes.push(`restore ${request.item.itemId} ${caller.by}`),
        { ok: true }
      ),
      revert: async (request: { batchId: string }, caller: { by: string }) => ((lastCaller = caller), writes.push(`revert ${request.batchId} ${caller.by}`), { ok: true }),
    } as unknown as CatalogRestoreUseCase,
    exporter: {
      run: (scope: { kind: string }) => ({ manifest: { scope: scope.kind, exportedAt: '2026-10-30T10:00:00.000Z', masked: [] }, files: {} }),
    } as unknown as CatalogExportUseCase,
    importPlanner: {
      planPackage: async (_input: unknown, options: unknown) => (planned.push(options), { ok: true }),
      planDocuments: async (documents: unknown) => (planned.push(documents), { ok: true }),
    } as unknown as Pick<CatalogImportPlanner, 'planPackage' | 'planDocuments'>,
    importApplier: { apply: async (_request: unknown, caller: { by: string }) => ((lastCaller = caller), { applied: true }) } as unknown as Pick<CatalogImportApplier, 'apply'>,
  })

  type TReply = { status: number; body?: { ok: boolean; result?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  type THandler = 'history' | 'revision' | 'diff' | 'restore' | 'revertBatch' | 'exportCatalog' | 'importPlan' | 'importApply' | 'batchList' | 'batchDetail'
  const call = (as: string, handler: THandler, input: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {}) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: TReply = { status: 0 }
      const res = {
        locals: {},
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: TReply['body']) {
          reply.body = payload
          return this
        },
        set() {
          return this
        },
        send() {
          return this
        },
      } as unknown as Response
      await controller[handler]({ params: input.params ?? {}, body: input.body, query: input.query ?? {} } as unknown as Request, res)
      return reply
    })
  const items = (reply: TReply) => (reply.body?.result?.revisions as Array<{ itemId: string }>).map((revision) => revision.itemId).sort()

  it('o histórico por escopo: a Ana lê o alfa e o global; a Bia, o beta; o root, só o global', async () => {
    assert.strictEqual((await call(ANA, 'history', { query: { project: 'alfa' } })).status, 200)
    assert.strictEqual((await call(ANA, 'history', { query: { project: 'beta' } })).status, 404)
    assert.strictEqual((await call(BIA, 'history', { query: { project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'history', { query: { project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'history', { query: { project: 'global' } })).status, 200)
    assert.strictEqual((await call(ANA, 'history', { query: { project: 'global' } })).status, 200)
    assert.strictEqual((await call(CAIO, 'history', { query: { project: 'global' } })).status, 404)
  })

  it('⛔ sem projeto: só o global e os projetos que administra (o root não vê o alfa nem o beta)', async () => {
    assert.deepStrictEqual(items(await call(ROOT, 'history')), ['r-global', 'r-lote-global'])
    assert.deepStrictEqual(items(await call(ANA, 'history')), ['alfa.n8n', 'r-global', 'r-lote-alfa', 'r-lote-global', 'theo'])
    assert.deepStrictEqual(items(await call(BIA, 'history')), ['beta.n8n', 'r-global', 'r-lote-beta', 'r-lote-global'])
    assert.strictEqual((await call(ANA, 'history', { query: { pageSize: '2' } })).body?.result.revisions.length, 2)
    assert.strictEqual((await call(ANA, 'history')).body?.result.total, 5)
  })

  it('o histórico de um item: o admin do projeto do item; o membro, só o MCP dele; o root não entra no alfa', async () => {
    assert.strictEqual((await call(ANA, 'history', { query: { kind: 'agent', id: 'theo' } })).status, 200)
    assert.strictEqual((await call(BIA, 'history', { query: { kind: 'agent', id: 'theo' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'history', { query: { kind: 'agent', id: 'theo' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'history', { query: { kind: 'mcp', id: 'n8n', project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'history', { query: { kind: 'rule', id: 'r-global' } })).status, 200)
    assert.strictEqual((await call(CAIO, 'history', { query: { kind: 'mcp', id: 'n8n', project: 'alfa' } })).status, 200)
    assert.strictEqual((await call(CAIO, 'history', { query: { kind: 'agent', id: 'theo' } })).status, 404)
    assert.strictEqual((await call(CAIO, 'history', { query: { project: 'alfa' } })).status, 200)
    assert.strictEqual((await call(ANA, 'revision', { query: { kind: 'agent', id: 'theo' }, params: { revision: '1' } })).status, 200)
    assert.strictEqual((await call(ROOT, 'revision', { query: { kind: 'agent', id: 'theo' }, params: { revision: '1' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'diff', { query: { kind: 'agent', id: 'theo' } })).status, 404)
  })

  it('⛔ restaurar e reverter: o admin do escopo; o global é do gateway', async () => {
    const restore = (project: string | undefined, id: string, kind = 'rule') => ({ body: { kind, id, ...(project ? { project } : {}), revision: 1, expectedRevision: 1 } })
    assert.strictEqual((await call(ANA, 'restore', restore(undefined, 'theo', 'agent'))).status, 200)
    assert.strictEqual((await call(BIA, 'restore', restore(undefined, 'theo', 'agent'))).status, 404)
    assert.strictEqual((await call(ROOT, 'restore', restore(undefined, 'theo', 'agent'))).status, 404)
    assert.strictEqual((await call(ANA, 'restore', restore(undefined, 'r-global'))).status, 404, 'global só o gateway grava')
    assert.strictEqual((await call(ROOT, 'restore', restore(undefined, 'r-global'))).status, 200)
    assert.strictEqual((await call(ANA, 'revertBatch', { params: { batchId: 'lote-alfa' } })).status, 200)
    assert.strictEqual((await call(ROOT, 'revertBatch', { params: { batchId: 'lote-alfa' } })).status, 404)
    assert.strictEqual((await call(BIA, 'revertBatch', { params: { batchId: 'lote-alfa' } })).status, 404)
    assert.strictEqual((await call(ANA, 'revertBatch', { params: { batchId: 'lote-global' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'revertBatch', { params: { batchId: 'lote-global' } })).status, 200)
    assert.deepStrictEqual(writes, ['restore theo u_ana@x.test', 'restore r-global u_root@x.test', 'revert lote-alfa u_ana@x.test', 'revert lote-global u_root@x.test'])
  })

  it('⛔ restaurar, reverter e importar levam ao caso de uso o que quem pede administra (a trava do sharedWith)', async () => {
    const administers = () => ({ alfa: lastCaller!.administers!('alfa'), beta: lastCaller!.administers!('beta') })
    await call(ANA, 'restore', { body: { kind: 'agent', id: 'theo', revision: 1, expectedRevision: 1 } })
    assert.deepStrictEqual(administers(), { alfa: true, beta: false })
    await call(ANA, 'revertBatch', { params: { batchId: 'lote-alfa' } })
    assert.deepStrictEqual(administers(), { alfa: true, beta: false })
    await call(BIA, 'importApply', { body: { package: { manifest: { scope: 'project:beta' }, files: {} }, planHash: 'a'.repeat(64) } })
    assert.deepStrictEqual(administers(), { alfa: false, beta: true })
  })

  it('os lotes: cada admin lista e abre os do escopo dele', async () => {
    const ids = (reply: TReply) => (reply.body?.result.batches as Array<{ id: string }>).map((entry) => entry.id).sort()
    assert.deepStrictEqual(ids(await call(ROOT, 'batchList')), ['lote-global'])
    assert.deepStrictEqual(ids(await call(ANA, 'batchList')), ['lote-alfa', 'lote-global'])
    assert.strictEqual((await call(ROOT, 'batchList', { query: { project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ANA, 'batchList', { query: { project: 'alfa' } })).status, 200)
    assert.strictEqual((await call(ANA, 'batchDetail', { params: { batchId: 'lote-alfa' } })).status, 200)
    assert.strictEqual((await call(ROOT, 'batchDetail', { params: { batchId: 'lote-alfa' } })).status, 404)
    assert.strictEqual((await call(BIA, 'batchDetail', { params: { batchId: 'lote-alfa' } })).status, 404)
    assert.strictEqual((await call(CAIO, 'batchList')).status, 404)
  })

  it('o export: o projeto, o admin dele; o global, qualquer admin lê; `all`, só quem administra tudo', async () => {
    const exportOf = (as: string, query: Record<string, string>) => call(as, 'exportCatalog', { query: { format: 'json', ...query } })
    assert.strictEqual((await exportOf(ANA, { scope: 'project', project: 'alfa' })).status, 200)
    assert.strictEqual((await exportOf(BIA, { scope: 'project', project: 'alfa' })).status, 404)
    assert.strictEqual((await exportOf(ROOT, { scope: 'project', project: 'alfa' })).status, 404)
    assert.strictEqual((await exportOf(ROOT, { scope: 'global' })).status, 200)
    assert.strictEqual((await exportOf(ANA, { scope: 'global' })).status, 200)
    assert.strictEqual((await exportOf(CAIO, { scope: 'global' })).status, 404)
    assert.strictEqual((await exportOf(ROOT, {})).status, 404, 'tudo, o root não administra')
    assert.strictEqual((await exportOf(ANA, { scope: 'all' })).status, 404)
  })

  it('o plano e o apply do import: o escopo do pacote decide quem; global só o gateway', async () => {
    const pack = (scope: string) => ({ manifest: { scope }, files: {} })
    const plan = (as: string, body: unknown, query: Record<string, string> = {}) => call(as, 'importPlan', { body, query })
    assert.strictEqual((await plan(ANA, pack('project:alfa'))).status, 200)
    assert.strictEqual((await plan(BIA, pack('project:alfa'))).status, 404)
    assert.strictEqual((await plan(ROOT, pack('project:alfa'))).status, 404)
    assert.strictEqual((await plan(ROOT, pack('global'))).status, 200)
    assert.strictEqual((await plan(ANA, pack('global'))).status, 404, 'importar no global é do gateway')
    assert.strictEqual((await plan(ANA, pack('all'))).status, 404)
    assert.strictEqual((await plan(ANA, { files: {} }, { project: 'beta' })).status, 404)
    // Documentos soltos: cada um tem de ser de um escopo dela.
    const doc = (projectId?: string) => ({ kind: 'rule', id: 'x', ...(projectId ? { projectId } : {}), body: {} })
    assert.strictEqual((await plan(ANA, { documents: [doc('alfa')] })).status, 200)
    assert.strictEqual((await plan(ANA, { documents: [doc('alfa'), doc('beta')] })).status, 404)
    assert.strictEqual((await plan(ANA, { documents: [doc('alfa'), doc()] })).status, 404)
    assert.strictEqual((await plan(CAIO, { documents: [doc('alfa')] })).status, 404)

    const planHash = 'a'.repeat(64)
    assert.strictEqual((await call(ANA, 'importApply', { body: { package: pack('project:alfa'), planHash } })).status, 200)
    assert.strictEqual((await call(ROOT, 'importApply', { body: { package: pack('project:alfa'), planHash } })).status, 404)
    assert.strictEqual((await call(ROOT, 'importApply', { body: { package: pack('global'), planHash } })).status, 200)
    assert.strictEqual((await call(ANA, 'importApply', { body: { documents: [doc('alfa')], scope: 'project:beta', planHash } })).status, 404)
    assert.strictEqual((await call(CAIO, 'importApply', { body: { package: pack('project:alfa'), planHash } })).status, 404)
  })
})
