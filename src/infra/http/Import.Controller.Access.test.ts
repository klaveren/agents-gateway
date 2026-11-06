import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { ImportController, IImportIgnoreStore } from './Import.Controller'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { useProjectAccess } from './Project.Access'

/** ⛔ O isolamento por projeto (ver `Project.Access`): o import de um projeto é do admin dele. */
describe('Import: o admin do projeto, só o projeto dele', () => {
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
      agentProject: (agentId) => ({ 'agente-alfa': 'alfa', 'agente-beta': 'beta', 'agente-global': null })[agentId],
    }),
  )
  after(() => useProjectAccess(undefined))

  type TReply = { status: number; body?: { ok: boolean; result?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  const callOf =
    <H extends string>(controller: Record<H, (req: Request, res: Response) => Promise<unknown>>) =>
    (as: string, handler: H, input: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {}) =>
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
        } as unknown as Response
        await controller[handler]({ params: input.params ?? {}, body: input.body, query: input.query ?? {} } as unknown as Request, res)
        return reply
      })

  const patterns = new Map<string, string[]>()
  const ignore: IImportIgnoreStore = { get: (projectId) => patterns.get(projectId) ?? [], set: (projectId, next) => (patterns.set(projectId, [...next]), [...next]) }
  const call = callOf(new ImportController({ scan: {} as ImportScanUseCase, projectExists: (id) => id in members, ignore, proof }))

  it('a Ana lê e grava o import do alfa; a Bia, o root e o membro, 404', async () => {
    assert.strictEqual((await call(ANA, 'getIgnore', { params: { id: 'alfa' } })).status, 200)
    assert.strictEqual((await call(ANA, 'setIgnore', { params: { id: 'alfa' }, body: { patterns: ['dist/'] } })).status, 200)
    assert.deepStrictEqual(patterns.get('alfa'), ['dist/'])
    for (const [name, who] of [
      ['a Bia', BIA],
      ['o root', ROOT],
      ['o Caio', CAIO],
    ] as const) {
      assert.strictEqual((await call(who, 'getIgnore', { params: { id: 'alfa' } })).status, 404, `ler: ${name}`)
      assert.strictEqual((await call(who, 'setIgnore', { params: { id: 'alfa' }, body: { patterns: ['x'] } })).status, 404, `gravar: ${name}`)
    }
    assert.deepStrictEqual(patterns.get('alfa'), ['dist/'])
  })

  it('o projeto que não existe é 404 para todos', async () => {
    assert.strictEqual((await call(ROOT, 'getIgnore', { params: { id: 'fantasma' } })).status, 404)
    assert.strictEqual((await call(ANA, 'getIgnore', { params: { id: 'fantasma' } })).status, 404)
  })
})
