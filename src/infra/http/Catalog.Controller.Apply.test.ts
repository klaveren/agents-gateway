import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { Request, Response } from 'express'
import { CatalogHistoryQuery } from '@application/CatalogHistory.Query'
import { agentDocument, docDocument } from '@domain/Catalog.Document'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { buildCatalogStack } from '../../testing/Catalog.Fixture'
import { CatalogController } from './Catalog.Controller'

const at = new Date('2026-10-30T12:00:00.000Z')

describe('POST /catalog/import/apply e GET /catalog/batches (só admin)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const MEMBER = token('u_ana', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }

  function build() {
    const stack = buildCatalogStack()
    const controller = new CatalogController({
      history: new CatalogHistoryQuery(stack.repository, stack.reader),
      proof,
      importPlanner: stack.planner,
      importApplier: stack.applier,
      batches: stack.repository,
    })
    return { stack, controller }
  }

  type TReply = { status: number; body?: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  type THandler = 'importPlan' | 'importApply' | 'batchList' | 'batchDetail'
  const call = (
    controller: CatalogController,
    handler: THandler,
    as: string | undefined,
    request: { body?: unknown; query?: Record<string, string>; params?: Record<string, string> },
    viaToken = false,
  ) =>
    withCaller(as ? { token: as, ...identityFromToken(as) } : {}, async () => {
      const reply: TReply = { status: 0 }
      const res = {
        locals: viaToken ? { viaAccessToken: true } : {},
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: unknown) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      await controller[handler]({ query: request.query ?? {}, params: request.params ?? {}, body: request.body } as unknown as Request, res)
      return reply
    })

  const spec = docDocument({ id: 'guia', kind: 'spec', title: 'Guia', summary: 'S', body: 'B', docIds: [], createdAt: at, updatedAt: at })
  const theo = agentDocument(
    { id: 'theo', name: 'Theo', providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }], systemPrompt: 'P', modes: [EMode.CHAT], allowedTools: ['alpha_tool'] },
    { resources: { skills: ['*'], commands: ['*'] }, initialContext: [] },
  )
  const wire = (documents: Array<{ kind: string; id: string; projectId?: string; body: unknown }>) =>
    documents.map(({ kind, id, projectId, body }) => ({ kind, id, ...(projectId ? { projectId } : {}), body }))

  it('o plano aceita os documentos canônicos; o apply grava com o planHash dele, num lote que as rotas de lote leem', async () => {
    const { stack, controller } = build()
    const documents = wire([spec])
    const plan = await call(controller, 'importPlan', ADMIN, { body: { documents } })
    assert.strictEqual(plan.status, 200)
    assert.strictEqual(plan.body.result.items[0].op, 'create')

    const applied = await call(controller, 'importApply', ADMIN, { body: { documents, planHash: plan.body.result.planHash } })
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body))
    const batchId = applied.body.result.batch.id
    assert.strictEqual(applied.body.result.batch.status, 'applied')
    assert.strictEqual(stack.guidance.doc('guia').body, 'B')

    const list = await call(controller, 'batchList', ADMIN, { query: { project: 'global' } })
    assert.strictEqual(list.status, 200)
    assert.deepStrictEqual(
      list.body.result.batches.map((batch: { id: string; status: string; items: number }) => [batch.id, batch.status, batch.items]),
      [[batchId, 'applied', 1]],
    )
    assert.strictEqual(list.body.result.total, 1)
    const detail = await call(controller, 'batchDetail', ADMIN, { params: { batchId } })
    assert.strictEqual(detail.status, 200)
    assert.strictEqual(detail.body.result.batch.kind, 'import')
    assert.deepStrictEqual(
      detail.body.result.revisions.map((revision: { kind: string; itemId: string; op: string; document?: string }) => [
        revision.kind,
        revision.itemId,
        revision.op,
        revision.document,
      ]),
      [['spec', 'guia', 'import', undefined]],
    )
    assert.strictEqual((await call(controller, 'batchDetail', ADMIN, { params: { batchId: 'nao-existe' } })).status, 404)
    assert.strictEqual((await call(controller, 'batchList', ADMIN, { query: { kind: 'outro' } })).status, 422)
  })

  it('membro e anônimo: 404 em tudo (aplicar e ler lotes)', async () => {
    const { controller } = build()
    const body = { documents: wire([spec]), planHash: 'a'.repeat(64) }
    for (const as of [MEMBER, undefined]) {
      assert.strictEqual((await call(controller, 'importApply', as, { body })).status, 404)
      assert.strictEqual((await call(controller, 'batchList', as, {})).status, 404)
      assert.strictEqual((await call(controller, 'batchDetail', as, { params: { batchId: 'x' } })).status, 404)
    }
  })

  it('planHash velho: 409 plan_changed com o plano novo; corpo sem pacote nem documentos: 422', async () => {
    const { stack, controller } = build()
    const documents = wire([spec])
    const plan = await call(controller, 'importPlan', ADMIN, { body: { documents } })
    stack.guidance.createDoc({ id: 'guia', kind: 'spec', title: 'Outro', summary: 'S', body: 'X' }, 'bia')
    const reply = await call(controller, 'importApply', ADMIN, { body: { documents, planHash: plan.body.result.planHash } })
    assert.strictEqual(reply.status, 409)
    assert.strictEqual(reply.body.code, 'plan_changed')
    assert.strictEqual(reply.body.details.plan.items[0].op, 'update')
    assert.strictEqual((await call(controller, 'importApply', ADMIN, { body: { planHash: 'a'.repeat(64) } })).status, 422)
    assert.strictEqual((await call(controller, 'importApply', ADMIN, { body: { documents, planHash: 'curto' } })).status, 422)
  })

  it('item com erro: 422 import_blocked com os motivos, nada gravado', async () => {
    const { stack, controller } = build()
    const broken = { kind: 'skill', id: 'fantasma', body: { id: 'fantasma', kind: 'skill', description: 'D', body: 'B', docIds: ['nao-existe'] } }
    const plan = await call(controller, 'importPlan', ADMIN, { body: { documents: [broken] } })
    const reply = await call(controller, 'importApply', ADMIN, { body: { documents: [broken], planHash: plan.body.result.planHash } })
    assert.strictEqual(reply.status, 422)
    assert.strictEqual(reply.body.code, 'import_blocked')
    assert.strictEqual(reply.body.details.blockers[0].ref, 'skill/fantasma')
    assert.strictEqual(stack.repository.batches({}, { offset: 0, limit: 5 }).total, 0)
  })

  it('ampliação: sem confirm 409 com a lista; por token 403 mesmo com confirm; admin na tela com confirm grava', async () => {
    const { stack, controller } = build()
    const documents = wire([theo])
    const plan = await call(controller, 'importPlan', ADMIN, { body: { documents } })
    const planHash = plan.body.result.planHash
    const keys = plan.body.result.widenings.map((widening: { key: string }) => widening.key)

    const missing = await call(controller, 'importApply', ADMIN, { body: { documents, planHash } })
    assert.strictEqual(missing.status, 409)
    assert.strictEqual(missing.body.code, 'widening_confirmation_required')
    assert.deepStrictEqual(
      missing.body.details.widenings.map((widening: { key: string }) => widening.key),
      keys,
    )
    const ci = await call(controller, 'importApply', ADMIN, { body: { documents, planHash, confirm: keys } }, true)
    assert.strictEqual(ci.status, 403)
    assert.strictEqual(stack.agents.entry('theo'), undefined)

    const ok = await call(controller, 'importApply', ADMIN, { body: { documents, planHash, confirm: keys } })
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body))
    const batch = (await call(controller, 'batchDetail', ADMIN, { params: { batchId: ok.body.result.batch.id } })).body.result.batch
    assert.deepStrictEqual(
      batch.widenings.map((widening: { key: string }) => widening.key),
      keys,
    )
    assert.strictEqual(batch.by, 'u_root@x.test')
  })
})
