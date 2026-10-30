import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { CatalogHistoryQuery } from '@application/CatalogHistory.Query'
import type { CatalogRestoreUseCase, IRestoreCaller } from '@application/CatalogRestore.Usecase'
import { CatalogWideningConfirmationError, CatalogWideningForbiddenError } from '@domain/errors/Domain.Error'
import { canonicalize, catalogHash, ICatalogDocument, TCanonicalBody, TCatalogKind } from '@domain/Catalog.Document'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteCatalogHistoryRepository } from '@infra/persistence/Sqlite.CatalogHistoryRepository'
import { CatalogController } from './Catalog.Controller'

const doc = (kind: TCatalogKind, id: string, projectId: string | undefined, body: TCanonicalBody): ICatalogDocument => {
  const text = canonicalize(body)
  return { kind, id, ...(projectId ? { projectId } : {}), body, text, hash: catalogHash(text) }
}

/** O histórico: alfa (projeto da Ana) e beta (não), um MCP em cada, um global, um agente em alfa e uma rule global. */
describe('GET /catalog/history (histórico do catálogo, só leitura)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const MEMBER = token('u_ana', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, string[]> = { alfa: ['u_ana'], beta: [] }

  const repository = new SqliteCatalogHistoryRepository(':memory:')
  const current = new Map<string, ICatalogDocument>()
  const controller = new CatalogController({
    history: new CatalogHistoryQuery(repository, { read: (kind, id, projectId) => current.get(`${kind}:${projectId ? `${projectId}.` : ''}${id}`) }),
    proof,
    projects: { canUse: (caller, projectId) => projectId in members && (caller.admin || members[projectId].includes(caller.userId ?? '')) },
  })

  /** Grava a revisão e deixa o documento como o atual. */
  const save = (kind: TCatalogKind, itemId: string, projectId: string | undefined, body: TCanonicalBody | undefined, at: string, op: 'create' | 'update' | 'delete') => {
    const id = kind === 'mcp' && projectId ? itemId.slice(projectId.length + 1) : itemId
    const key = `${kind}:${kind === 'mcp' && projectId ? `${projectId}.` : ''}${id}`
    if (body) current.set(key, doc(kind, id, projectId, body))
    else current.delete(key)
    const document = body ? current.get(key) : undefined
    repository.append({
      kind,
      itemId,
      ...(projectId ? { projectId } : {}),
      op,
      ...(document ? { document: document.text, hash: document.hash } : {}),
      at: new Date(at),
      by: 'root@x.test',
      source: 'api',
    })
  }

  before(() => {
    save('mcp', 'alfa.n8n', 'alfa', { id: 'n8n', name: 'N8N', url: 'https://n8n.alfa/mcp', secrets: ['header'] }, '2026-10-30T10:00:00Z', 'create')
    save('mcp', 'alfa.n8n', 'alfa', { id: 'n8n', name: 'N8N de alfa', url: 'https://n8n.alfa/mcp', secrets: ['header'] }, '2026-10-30T11:00:00Z', 'update')
    save('mcp', 'alfa.n8n', 'alfa', { id: 'n8n', name: 'N8N de alfa', url: 'https://n8n2.alfa/mcp', secrets: ['header'] }, '2026-10-30T12:00:00Z', 'update')
    save('mcp', 'beta.n8n', 'beta', { id: 'n8n', name: 'N8N de beta', url: 'https://n8n.beta/mcp' }, '2026-10-30T10:30:00Z', 'create')
    save('mcp', 'github', undefined, { id: 'github', name: 'GitHub', url: 'https://gh/mcp' }, '2026-10-30T09:00:00Z', 'create')
    save('agent', 'theo', 'alfa', { id: 'theo', name: 'Theo', systemPrompt: 'Prompt secreto de alfa', projectId: 'alfa' }, '2026-10-30T13:00:00Z', 'create')
    save('rule', 'r-1', undefined, { id: 'r-1', title: 'Global', body: 'Seja breve.', enabled: true, position: 0 }, '2026-10-30T08:00:00Z', 'create')
    save('rule', 'r-1', undefined, undefined, '2026-10-30T14:00:00Z', 'delete')
  })

  type TReply = { status: number; body?: { ok: boolean; result?: any; code?: string; message?: string } } // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (as: string | undefined, handler: 'history' | 'revision' | 'diff', query: Record<string, string>, params: Record<string, string> = {}) =>
    withCaller(as ? { token: as, ...identityFromToken(as) } : {}, async () => {
      const reply: TReply = { status: 0 }
      const res = {
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: TReply['body']) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      await controller[handler]({ query, params } as unknown as Request, res)
      return reply
    })

  it('lista as revisões do item, da mais nova para a mais velha, sem o documento, com o estado atual', async () => {
    const reply = await call(ADMIN, 'history', { kind: 'mcp', id: 'alfa.n8n' })
    assert.strictEqual(reply.status, 200)
    const result = reply.body?.result
    assert.deepStrictEqual(
      result.revisions.map((revision: { revision: number; op: string }) => [revision.revision, revision.op]),
      [
        [3, 'update'],
        [2, 'update'],
        [1, 'create'],
      ],
    )
    assert.strictEqual(result.total, 3)
    assert.ok(result.revisions.every((revision: { document?: string }) => revision.document === undefined))
    assert.deepStrictEqual(result.current, { exists: true, hash: result.revisions[0].hash })
  })

  it('MCP pela chave do projeto: `id=n8n&project=alfa` é `alfa.n8n`, e não o de beta', async () => {
    const byKey = await call(ADMIN, 'history', { kind: 'mcp', id: 'alfa.n8n' })
    const byProject = await call(ADMIN, 'history', { kind: 'mcp', id: 'n8n', project: 'alfa' })
    assert.deepStrictEqual(byProject.body?.result, byKey.body?.result)
    assert.strictEqual(byProject.body?.result.itemId, 'alfa.n8n')
    const beta = await call(ADMIN, 'history', { kind: 'mcp', id: 'n8n', project: 'beta' })
    assert.strictEqual(beta.body?.result.total, 1)
    assert.strictEqual((await call(ADMIN, 'history', { kind: 'mcp', id: 'a.b.c' })).status, 422)
  })

  it('paginação: pageSize e page recortam; o total é o do recorte inteiro', async () => {
    const first = await call(ADMIN, 'history', { kind: 'mcp', id: 'alfa.n8n', pageSize: '2' })
    const second = await call(ADMIN, 'history', { kind: 'mcp', id: 'alfa.n8n', pageSize: '2', page: '2' })
    assert.deepStrictEqual(
      first.body?.result.revisions.map((revision: { revision: number }) => revision.revision),
      [3, 2],
    )
    assert.deepStrictEqual(
      second.body?.result.revisions.map((revision: { revision: number }) => revision.revision),
      [1],
    )
    assert.deepStrictEqual([second.body?.result.total, second.body?.result.page, second.body?.result.pageSize], [3, 2, 2])
    // Lixo vira o padrão (tela de leitura), e o teto segura a página gigante.
    assert.deepStrictEqual([(await call(ADMIN, 'history', { page: 'abc', pageSize: '100000' })).body?.result.pageSize], [100])
  })

  it('o escopo: o projeto, o global e tudo, pela data, da mais nova para a mais velha', async () => {
    const alfa = await call(ADMIN, 'history', { project: 'alfa' })
    assert.deepStrictEqual(
      alfa.body?.result.revisions.map((revision: { kind: string; itemId: string; revision: number }) => `${revision.kind}/${revision.itemId}@${revision.revision}`),
      ['agent/theo@1', 'mcp/alfa.n8n@3', 'mcp/alfa.n8n@2', 'mcp/alfa.n8n@1'],
    )
    assert.strictEqual(alfa.body?.result.scope, 'project:alfa')
    const global = await call(ADMIN, 'history', { project: 'global' })
    assert.deepStrictEqual(
      global.body?.result.revisions.map((revision: { kind: string; itemId: string; revision: number }) => `${revision.kind}/${revision.itemId}@${revision.revision}`),
      ['rule/r-1@2', 'mcp/github@1', 'rule/r-1@1'],
    )
    assert.strictEqual((await call(ADMIN, 'history', {})).body?.result.total, 8)
  })

  it('lê uma revisão inteira, com o documento; a de delete vem sem documento', async () => {
    const reply = await call(ADMIN, 'revision', { kind: 'mcp', id: 'alfa.n8n' }, { revision: '1' })
    assert.strictEqual(reply.status, 200)
    assert.strictEqual(JSON.parse(reply.body?.result.document).name, 'N8N')
    const deleted = await call(ADMIN, 'revision', { kind: 'rule', id: 'r-1' }, { revision: '2' })
    assert.deepStrictEqual([deleted.body?.result.op, deleted.body?.result.document], ['delete', undefined])
  })

  it('revisão ou item que não existe: 404; parâmetro inválido: 422', async () => {
    assert.strictEqual((await call(ADMIN, 'revision', { kind: 'mcp', id: 'alfa.n8n' }, { revision: '9' })).status, 404)
    assert.strictEqual((await call(ADMIN, 'diff', { kind: 'mcp', id: 'alfa.n8n', from: '1', to: '9' })).status, 404)
    assert.strictEqual((await call(ADMIN, 'history', { kind: 'agent', id: 'ninguem' })).status, 404)
    assert.strictEqual((await call(ADMIN, 'diff', { kind: 'agent', id: 'ninguem' })).status, 404)
    assert.strictEqual((await call(ADMIN, 'revision', { kind: 'mcp', id: 'alfa.n8n' }, { revision: '0' })).status, 422)
    assert.strictEqual((await call(ADMIN, 'revision', { kind: 'mcp', id: 'alfa.n8n' }, { revision: 'x' })).status, 422)
    assert.strictEqual((await call(ADMIN, 'history', { kind: 'nada', id: 'x' })).status, 422)
    assert.strictEqual((await call(ADMIN, 'history', { kind: 'agent' })).status, 422)
    assert.strictEqual((await call(ADMIN, 'diff', { kind: 'mcp', id: 'alfa.n8n', from: '-1' })).status, 422)
  })

  it('diff entre duas revisões: hunks com contexto e o texto unificado', async () => {
    const reply = await call(ADMIN, 'diff', { kind: 'mcp', id: 'alfa.n8n', from: '1', to: '2' })
    assert.strictEqual(reply.status, 200)
    const result = reply.body?.result
    assert.deepStrictEqual([result.equal, result.added, result.removed], [false, 1, 1])
    assert.deepStrictEqual([result.from.revision, result.to.revision, result.from.op, result.to.exists], [1, 2, 'create', true])
    assert.ok(result.unified.startsWith('--- mcp/alfa.n8n@1\n+++ mcp/alfa.n8n@2\n@@ '))
    assert.ok(result.unified.includes('-  "name": "N8N",\n+  "name": "N8N de alfa",\n'))
  })

  it('diff com o atual: o padrão compara a última revisão com o estado de agora (igual, sem deriva)', async () => {
    const reply = await call(ADMIN, 'diff', { kind: 'mcp', id: 'alfa.n8n' })
    assert.deepStrictEqual([reply.body?.result.from.revision, reply.body?.result.to.revision, reply.body?.result.equal], [3, 'current', true])
    const since = await call(ADMIN, 'diff', { kind: 'mcp', id: 'alfa.n8n', from: '1', to: 'current' })
    assert.deepStrictEqual([since.body?.result.equal, since.body?.result.added, since.body?.result.removed], [false, 2, 2])
    // Só `to`: o que aquela revisão mudou. `0` = antes de existir.
    const created = await call(ADMIN, 'diff', { kind: 'mcp', id: 'alfa.n8n', to: '1' })
    assert.deepStrictEqual([created.body?.result.from.revision, created.body?.result.from.exists, created.body?.result.removed], [0, false, 0])
    // Item apagado: o atual não existe, e o diff da última revisão com documento é tudo saindo.
    const gone = await call(ADMIN, 'diff', { kind: 'rule', id: 'r-1', from: '1' })
    assert.deepStrictEqual([gone.body?.result.to.exists, gone.body?.result.added, gone.body?.result.removed > 0], [false, 0, true])
  })

  it('⛔ o membro lê o MCP do projeto dele (lista, revisão, diff e o escopo só com MCP)', async () => {
    assert.strictEqual((await call(MEMBER, 'history', { kind: 'mcp', id: 'n8n', project: 'alfa' })).body?.result.total, 3)
    assert.strictEqual((await call(MEMBER, 'revision', { kind: 'mcp', id: 'alfa.n8n' }, { revision: '2' })).status, 200)
    assert.strictEqual((await call(MEMBER, 'diff', { kind: 'mcp', id: 'alfa.n8n', from: '1' })).status, 200)
    const scope = await call(MEMBER, 'history', { project: 'alfa' })
    assert.deepStrictEqual(
      scope.body?.result.revisions.map((revision: { kind: string }) => revision.kind),
      ['mcp', 'mcp', 'mcp'],
    )
    assert.ok(!JSON.stringify(scope.body).includes('Prompt secreto'))
  })

  it('⛔ o membro não vê item de outro projeto, nem o global, nem o que hoje é só de admin: 404', async () => {
    for (const [handler, query, params] of [
      ['history', { kind: 'mcp', id: 'beta.n8n' }, {}],
      ['revision', { kind: 'mcp', id: 'n8n', project: 'beta' }, { revision: '1' }],
      ['diff', { kind: 'mcp', id: 'beta.n8n' }, {}],
      ['history', { kind: 'mcp', id: 'github' }, {}],
      ['history', { kind: 'agent', id: 'theo' }, {}],
      ['revision', { kind: 'agent', id: 'theo' }, { revision: '1' }],
      ['history', { kind: 'rule', id: 'r-1' }, {}],
      ['history', { project: 'beta' }, {}],
      ['history', { project: 'global' }, {}],
      ['history', {}, {}],
    ] as const) {
      const reply = await call(MEMBER, handler, { ...query }, { ...params })
      assert.deepStrictEqual([reply.status, reply.body?.code], [404, 'not_found'], `${handler} ${JSON.stringify(query)}`)
    }
  })

  it('⛔ sem identidade provada: 404 em tudo', async () => {
    assert.strictEqual((await call(undefined, 'history', { kind: 'mcp', id: 'alfa.n8n' })).status, 404)
    const forged = `${MEMBER.slice(0, -4)}AAAA`
    assert.strictEqual((await call(forged, 'history', { project: 'alfa' })).status, 404)
  })
})

describe('POST /catalog/history/restore e /catalog/batches/:id/revert (rollback, só admin)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const MEMBER = token('u_ana', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }

  const seen: Array<{ request: unknown; caller: IRestoreCaller }> = []
  const restore = {
    restore: async (request: unknown, caller: IRestoreCaller) => {
      seen.push({ request, caller })
      if (caller.viaAccessToken) throw new CatalogWideningForbiddenError([{ key: 'agent/theo#allowedTools+cap:terminal', description: 'ganha o terminal' }])
      return { unchanged: false }
    },
    revert: async (request: unknown, caller: IRestoreCaller) => {
      seen.push({ request, caller })
      throw new CatalogWideningConfirmationError([{ key: 'agent/theo#allowedTools+cap:terminal', description: 'ganha o terminal' }])
    },
  } as unknown as CatalogRestoreUseCase
  const controller = new CatalogController({ history: new CatalogHistoryQuery(new SqliteCatalogHistoryRepository(':memory:'), { read: () => undefined }), proof, restore })

  type TReply = { status: number; body?: { ok: boolean; result?: any; code?: string; details?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (as: string, handler: 'restore' | 'revertBatch', body: unknown, options: { params?: Record<string, string>; viaToken?: boolean } = {}) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: TReply = { status: 0 }
      const res = {
        locals: options.viaToken ? { viaAccessToken: true } : {},
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: TReply['body']) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      await controller[handler]({ body, params: options.params ?? {}, query: {} } as unknown as Request, res)
      return reply
    })
  const body = { kind: 'mcp', id: 'n8n', project: 'alfa', revision: 2, expectedRevision: 5, confirm: ['k'] }

  it('quem não é admin recebe 404, e o rollback nem é chamado', async () => {
    seen.length = 0
    assert.strictEqual((await call(MEMBER, 'restore', body)).status, 404)
    assert.strictEqual((await call(MEMBER, 'revertBatch', {}, { params: { batchId: 'lote-1' } })).status, 404)
    assert.strictEqual(seen.length, 0)
  })

  it('admin pela tela: a chave do item completa como na leitura, e o pedido chega com quem e por onde', async () => {
    seen.length = 0
    const reply = await call(ADMIN, 'restore', body)
    assert.strictEqual(reply.status, 200)
    assert.deepStrictEqual(seen[0], {
      request: { item: { kind: 'mcp', itemId: 'alfa.n8n' }, revision: 2, expectedRevision: 5, confirm: ['k'] },
      caller: { by: 'u_root@x.test', viaAccessToken: false },
    })
  })

  it('token de acesso: o controller o distingue da sessão, e a ampliação vira 403', async () => {
    seen.length = 0
    const reply = await call(ADMIN, 'restore', body, { viaToken: true })
    assert.strictEqual(seen[0].caller.viaAccessToken, true)
    assert.deepStrictEqual([reply.status, reply.body?.code], [403, 'forbidden'])
    assert.strictEqual(reply.body?.details.widenings[0].key, 'agent/theo#allowedTools+cap:terminal')
  })

  it('confirm que não bate: 409 com a lista certa; corpo inválido: 422', async () => {
    const reply = await call(ADMIN, 'revertBatch', { confirm: [] }, { params: { batchId: 'lote-1' } })
    assert.deepStrictEqual([reply.status, reply.body?.code], [409, 'widening_confirmation_required'])
    assert.strictEqual(reply.body?.details.widenings.length, 1)
    assert.strictEqual((await call(ADMIN, 'restore', { ...body, revision: 0 })).status, 422)
    assert.strictEqual((await call(ADMIN, 'restore', { ...body, kind: 'nada' })).status, 422)
  })
})
