import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { Request, Response } from 'express'
import { TCatalogScope } from '@application/Catalog.Reader'
import { CatalogExportUseCase } from '@application/CatalogExport.Usecase'
import { CatalogHistoryQuery } from '@application/CatalogHistory.Query'
import { CatalogImportPlanner } from '@application/CatalogImport.Plan'
import { docDocument, ICatalogDocument, projectDocument } from '@domain/Catalog.Document'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { tarGz } from '@infra/catalog/Tar.Archive'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteCatalogHistoryRepository } from '@infra/persistence/Sqlite.CatalogHistoryRepository'
import { CatalogController, EXPORT_ROOT } from './Catalog.Controller'

const at = new Date('2026-10-30T12:00:00.000Z')

describe('POST /catalog/import/plan (só admin, dry-run)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const MEMBER = token('u_ana', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }

  const documents: ICatalogDocument[] = [
    projectDocument({ id: 'alfa', name: 'Alfa', createdAt: at, updatedAt: at }, []),
    docDocument({ id: 'spec-g', kind: 'spec', title: 'Global', summary: 'S', body: 'B', createdAt: at, updatedAt: at }),
    docDocument({ id: 'spec-a', kind: 'spec', projectId: 'alfa', title: 'Alfa', summary: 'S', body: 'B', createdAt: at, updatedAt: at }),
  ]
  const inScope = (scope: TCatalogScope, document: ICatalogDocument) =>
    scope.kind === 'all' || (scope.kind === 'global' ? !document.projectId : document.projectId === scope.projectId)
  const reader = {
    list: (scope: TCatalogScope) => documents.filter((document) => inScope(scope, document)),
    read: (kind: string, id: string) => documents.find((document) => document.kind === kind && document.id === id),
  }
  const exporter = new CatalogExportUseCase({ reader, mask: { scan: (value) => ({ text: value, hits: [] }) }, now: () => at })
  const importPlanner = new CatalogImportPlanner({ reader, mcpSecrets: { secretStatus: () => ({ configured: false }) as never, envStatus: () => [] } })
  const history = () => new CatalogHistoryQuery(new SqliteCatalogHistoryRepository(':memory:'), { read: () => undefined })
  const controller = new CatalogController({ history: history(), proof, importPlanner })

  type TReply = { status: number; body?: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (as: string | undefined, body: unknown, options: { query?: Record<string, string>; viaToken?: boolean; target?: CatalogController } = {}) =>
    withCaller(as ? { token: as, ...identityFromToken(as) } : {}, async () => {
      const reply: TReply = { status: 0 }
      const res = {
        locals: options.viaToken ? { viaAccessToken: true } : {},
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: unknown) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      await (options.target ?? controller).importPlan({ query: options.query ?? {}, body } as unknown as Request, res)
      return reply
    })

  const pack = exporter.run({ kind: 'all' })
  const changed: Record<string, string> = { ...pack.files, 'global/specs/spec-g.md': pack.files['global/specs/spec-g.md'].replace(/B$/, 'Corpo novo') }

  it('JSON { manifest, files }: o plano, com o escopo do manifesto', async () => {
    const reply = await call(ADMIN, { files: changed })
    assert.strictEqual(reply.status, 200)
    const plan = reply.body.result
    assert.strictEqual(plan.scope, 'all')
    assert.deepStrictEqual(
      plan.items.map((item: { ref: string; op: string }) => `${item.ref}:${item.op}`),
      ['project/alfa:unchanged', 'spec/spec-a:unchanged', 'spec/spec-g:update'],
    )
    assert.match(plan.planHash, /^[a-f0-9]{64}$/)
    assert.deepStrictEqual(plan.caller, { viaAccessToken: false, wideningsApplicable: true })
    // O manifesto à parte vale como o de dentro.
    const files: Record<string, string> = { ...changed }
    delete files['catalog.json']
    const apart = await call(ADMIN, { manifest: pack.manifest, files })
    assert.strictEqual(apart.body.result.planHash, plan.planHash)
  })

  it('.tar.gz do export (a pasta catalog/ sai do caminho): o mesmo plano do JSON', async () => {
    const archive = tarGz(
      Object.entries(changed).map(([path, content]) => ({ path: `${EXPORT_ROOT}/${path}`, content })),
      at,
    )
    const json = await call(ADMIN, { files: changed })
    const tar = await call(ADMIN, archive)
    assert.strictEqual(tar.status, 200)
    assert.strictEqual(tar.body.result.planHash, json.body.result.planHash)
    assert.strictEqual((await call(ADMIN, Buffer.from('não é gzip'))).status, 422)
  })

  it('escopo da query ganha do manifesto; o de fora do escopo vira erro', async () => {
    const reply = await call(ADMIN, { files: changed }, { query: { scope: 'project:alfa' } })
    assert.strictEqual(reply.status, 200)
    assert.strictEqual(reply.body.result.scope, 'project:alfa')
    const global = reply.body.result.items.find((item: { ref: string }) => item.ref === 'spec/spec-g')
    assert.strictEqual(global.op, 'error')
    assert.strictEqual((await call(ADMIN, { files: changed }, { query: { scope: 'tudo' } })).status, 422)
  })

  it('token de acesso planeja, mas o plano marca que ampliação não se aplica por token', async () => {
    const reply = await call(ADMIN, { files: changed }, { viaToken: true })
    assert.strictEqual(reply.status, 200)
    assert.deepStrictEqual(reply.body.result.caller, { viaAccessToken: true, wideningsApplicable: false })
  })

  it('⛔ quem não é admin (membro, anônimo) recebe 404; sem o planejador, 404; corpo inválido, 422', async () => {
    for (const as of [MEMBER, undefined]) {
      const reply = await call(as, { files: changed })
      assert.strictEqual(reply.status, 404)
      assert.ok(!JSON.stringify(reply.body).includes('spec-g'))
    }
    const unwired = new CatalogController({ history: history(), proof })
    assert.strictEqual((await call(ADMIN, { files: changed }, { target: unwired })).status, 404)
    assert.strictEqual((await call(ADMIN, { files: { 'a.md': 1 } })).status, 422)
    assert.strictEqual((await call(ADMIN, {})).status, 422)
  })
})
