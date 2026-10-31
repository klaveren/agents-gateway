import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { Request, Response } from 'express'
import { CatalogHistoryQuery } from '@application/CatalogHistory.Query'
import { CatalogExportUseCase } from '@application/CatalogExport.Usecase'
import { TCatalogScope } from '@application/Catalog.Reader'
import { docDocument, ICatalogDocument, projectDocument } from '@domain/Catalog.Document'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { untarGz } from '@infra/catalog/Tar.Archive'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteCatalogHistoryRepository } from '@infra/persistence/Sqlite.CatalogHistoryRepository'
import { CatalogController } from './Catalog.Controller'

const at = new Date('2026-10-30T12:00:00.000Z')

describe('GET /catalog/export (só admin)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const MEMBER = token('u_ana', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }

  const documents: ICatalogDocument[] = [
    projectDocument({ id: 'alfa', name: 'Alfa', createdAt: at, updatedAt: at }, []),
    docDocument({ id: 'spec-g', kind: 'spec', title: 'Global', summary: 'S', body: `token ghp_${'a'.repeat(36)}`, createdAt: at, updatedAt: at }),
    docDocument({ id: 'spec-a', kind: 'spec', projectId: 'alfa', title: 'Alfa', summary: 'S', body: 'B', createdAt: at, updatedAt: at }),
  ]
  const inScope = (scope: TCatalogScope, document: ICatalogDocument) =>
    scope.kind === 'all' || (scope.kind === 'global' ? !document.projectId : document.projectId === scope.projectId)
  const exporter = new CatalogExportUseCase({
    reader: {
      list: (scope) => documents.filter((document) => inScope(scope, document)),
      read: (kind, id) => documents.find((document) => document.kind === kind && document.id === id),
    },
    // Uma máscara mínima: só o formato de token do GitHub.
    mask: {
      scan: (value) => {
        const text = value.replace(/ghp_[A-Za-z0-9]{36}/g, '[segredo:token do GitHub]')
        return { text, hits: text === value ? [] : [{ layer: 'format', label: 'token do GitHub', length: 40 }] }
      },
    },
    now: () => at,
  })
  const controller = new CatalogController({ history: new CatalogHistoryQuery(new SqliteCatalogHistoryRepository(':memory:'), { read: () => undefined }), proof, exporter })

  type TReply = { status: number; headers: Record<string, string>; body?: any; raw?: Buffer } // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (as: string | undefined, query: Record<string, string>, target = controller) =>
    withCaller(as ? { token: as, ...identityFromToken(as) } : {}, async () => {
      const reply: TReply = { status: 0, headers: {} }
      const res = {
        locals: {},
        status(code: number) {
          reply.status = code
          return this
        },
        set(headers: Record<string, string>) {
          Object.assign(reply.headers, headers)
          return this
        },
        json(payload: unknown) {
          reply.body = payload
          return this
        },
        send(payload: Buffer) {
          reply.raw = payload
          return this
        },
      } as unknown as Response
      await target.exportCatalog({ query } as unknown as Request, res)
      return reply
    })

  it('padrão: um .tar.gz com a pasta catalog/, o manifesto e o que foi mascarado no header', async () => {
    const reply = await call(ADMIN, {})
    assert.strictEqual(reply.status, 200)
    assert.strictEqual(reply.headers['Content-Type'], 'application/gzip')
    assert.strictEqual(reply.headers['Content-Disposition'], 'attachment; filename="catalog-all-2026-10-30T12-00-00-000Z.tar.gz"')
    assert.strictEqual(reply.headers['X-Catalog-Masked'], '1')
    const entries = Object.fromEntries(untarGz(reply.raw!).map((entry) => [entry.path, entry.content.toString('utf8')]))
    assert.deepStrictEqual(Object.keys(entries).sort(), [
      'catalog/catalog.json',
      'catalog/global/specs/spec-g.md',
      'catalog/projects/alfa/project.json',
      'catalog/projects/alfa/specs/spec-a.md',
    ])
    assert.ok(entries['catalog/global/specs/spec-g.md'].endsWith('token [segredo:token do GitHub]'))
    const manifest = JSON.parse(entries['catalog/catalog.json'])
    assert.deepStrictEqual(manifest.masked, [{ field: 'body', id: 'spec-g', kind: 'spec', label: 'token do GitHub', layer: 'format', path: 'global/specs/spec-g.md' }])
    assert.strictEqual(manifest.exportedBy, 'u_root@x.test')
  })

  it('format=json: { manifest, files } no envelope; escopo de projeto só leva o projeto', async () => {
    for (const query of [{ scope: 'project', project: 'alfa' }, { scope: 'project:alfa' }, { project: 'alfa' }] as Record<string, string>[]) {
      const reply = await call(ADMIN, { ...query, format: 'json' })
      assert.strictEqual(reply.status, 200)
      assert.deepStrictEqual(Object.keys(reply.body.result.files), ['catalog.json', 'projects/alfa/project.json', 'projects/alfa/specs/spec-a.md'])
      assert.strictEqual(reply.body.result.manifest.scope, 'project:alfa')
    }
    const global = await call(ADMIN, { scope: 'global', format: 'json' })
    assert.deepStrictEqual(Object.keys(global.body.result.files), ['catalog.json', 'global/specs/spec-g.md'])
    const tar = await call(ADMIN, { scope: 'project', project: 'alfa' })
    assert.match(tar.headers['Content-Disposition'], /catalog-project-alfa-/)
  })

  it('⛔ quem não é admin (membro, anônimo) recebe 404, sem pacote', async () => {
    for (const as of [MEMBER, undefined]) {
      const reply = await call(as, { format: 'json' })
      assert.strictEqual(reply.status, 404)
      assert.strictEqual(reply.raw, undefined)
      assert.ok(!JSON.stringify(reply.body).includes('spec-g'))
    }
    const unwired = new CatalogController({ history: new CatalogHistoryQuery(new SqliteCatalogHistoryRepository(':memory:'), { read: () => undefined }), proof })
    assert.strictEqual((await call(ADMIN, {}, unwired)).status, 404)
  })

  it('projeto que não existe: 404; escopo, projeto ou formato inválido: 422', async () => {
    assert.strictEqual((await call(ADMIN, { scope: 'project', project: 'nada' })).status, 404)
    for (const query of [{ scope: 'tudo' }, { scope: 'project' }, { scope: 'project', project: '../x' }, { scope: 'global', project: 'alfa' }, { format: 'zip' }] as Record<
      string,
      string
    >[]) {
      assert.strictEqual((await call(ADMIN, query)).status, 422, JSON.stringify(query))
    }
  })
})
