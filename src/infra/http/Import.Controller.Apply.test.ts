import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { Request, Response } from 'express'
import type { ImportApplyUseCase } from '@application/ImportApply.Usecase'
import { ImportBuildError } from '@application/ImportBuild.Service'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { CatalogWideningForbiddenError } from '@domain/errors/Domain.Error'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { ImportController } from './Import.Controller'

/** As rotas da gravação do importador: a prévia e o gravar — só admin; o token de acesso chega marcado ao caso de uso. */
describe('gravação do importador (/projects/:id/import/jobs/:job/apply e apply/plan)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const MEMBER = token('u_ana', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const calls: Array<{ what: string; args: unknown[] }> = []
  const apply = {
    preview: async (...args: unknown[]) => {
      calls.push({ what: 'preview', args })
      if (args[1] === 'velho') throw new ImportBuildError('outdated', 'there is a newer analysis')
      return { plan: { planHash: 'h' } }
    },
    apply: async (...args: unknown[]) => {
      calls.push({ what: 'apply', args })
      if ((args[3] as { viaAccessToken: boolean }).viaAccessToken) throw new CatalogWideningForbiddenError([{ key: 'k', description: 'd' }])
      return { items: { applied: ['spec:a'], notApplied: [] } }
    },
  } as unknown as ImportApplyUseCase
  const scan = new ImportScanUseCase({ readTree: () => ({}) as never, detectors: [], findInCatalog: () => undefined })
  const controller = new ImportController({ scan, apply, projectExists: (projectId) => projectId === 'alfa', proof })
  const bare = new ImportController({ scan, projectExists: () => true, proof })

  type TReply = { status: number; body?: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (target: ImportController, handler: 'planApply' | 'applyItems', as: string, job: string, body: unknown, viaToken = false) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
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
      await target[handler]({ params: { id: 'alfa', job }, body } as unknown as Request, res)
      return reply
    })

  const HASH = 'a'.repeat(64)

  it('prévia: passa a seleção (lote, regras amplas incluídas, modelo) e o token; trabalho antigo = 409', async () => {
    calls.length = 0
    const body = { batchId: 'b1', wide: { 'agent:maya': ['terminal allow *'] }, models: { 'agent:maya': { provider: 'google', model: 'm' } } }
    const reply = await call(controller, 'planApply', ADMIN, 'j1', body)
    assert.strictEqual(reply.status, 200)
    assert.deepStrictEqual(calls[0].args, ['alfa', 'j1', body, { viaAccessToken: false }])
    assert.strictEqual((await call(controller, 'planApply', ADMIN, 'velho', {})).status, 409)
  })

  it('gravar: planHash obrigatório, confirm e quem; por token, 403 de ampliação', async () => {
    calls.length = 0
    assert.strictEqual((await call(controller, 'applyItems', ADMIN, 'j1', { keys: ['spec:a'] })).status, 422)
    const reply = await call(controller, 'applyItems', ADMIN, 'j1', { keys: ['spec:a'], planHash: HASH, confirm: ['k'] })
    assert.strictEqual(reply.status, 200)
    assert.deepStrictEqual(reply.body.result.items.applied, ['spec:a'])
    assert.deepStrictEqual(calls.at(-1)!.args, ['alfa', 'j1', { keys: ['spec:a'], planHash: HASH, confirm: ['k'] }, { by: 'u_root@x.test', viaAccessToken: false }])
    const viaToken = await call(controller, 'applyItems', ADMIN, 'j1', { planHash: HASH, confirm: ['k'] }, true)
    assert.strictEqual(viaToken.status, 403)
  })

  it('membro: 404; sem a gravação ligada: 404', async () => {
    assert.strictEqual((await call(controller, 'planApply', MEMBER, 'j1', {})).status, 404)
    assert.strictEqual((await call(controller, 'applyItems', MEMBER, 'j1', { planHash: HASH })).status, 404)
    assert.strictEqual((await call(bare, 'planApply', ADMIN, 'j1', {})).status, 404)
  })
})
