import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { AgentSchedulesService } from '@application/AgentSchedules.Service'
import { ScheduleRunner } from '@application/Schedule.Runner'
import { IAgentSchedule } from '@domain/models/AgentSchedule.Model'
import { SchedulesController } from './Schedules.Controller'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { useProjectAccess } from './Project.Access'

/** ⛔ O isolamento por projeto (ver `Project.Access`): o agendamento é do projeto do agente; no agente global, de onde ele roda. */
describe('Schedules: o admin do projeto, só os agendamentos dele', () => {
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

  const at = new Date()
  const schedule = (agentId: string, name: string, projectId?: string): IAgentSchedule =>
    ({
      agentId,
      name,
      cron: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'x',
      session: 'new',
      ...(projectId ? { projectId } : {}),
      enabled: true,
      runAs: 'u',
      failures: 0,
      createdAt: at,
      updatedAt: at,
      updatedBy: 'root',
    }) as IAgentSchedule
  const all = [schedule('agente-alfa', 'diario'), schedule('agente-beta', 'diario'), schedule('agente-global', 'g-global'), schedule('agente-global', 'g-alfa', 'alfa')]
  const find = (agentId: string, name: string) => {
    const found = all.find((entry) => entry.agentId === agentId && entry.name === name)
    if (!found) throw new Error('not found')
    return found
  }
  const schedules = {
    list: (agentId?: string) => all.filter((entry) => !agentId || entry.agentId === agentId),
    get: find,
    create: (agentId: string, input: { name: string; projectId?: string | null }) => schedule(agentId, input.name, input.projectId ?? undefined),
    update: (agentId: string, name: string) => find(agentId, name),
    remove: () => undefined,
    runs: () => [],
    nextRun: () => undefined,
  } as unknown as AgentSchedulesService
  const ran: Array<{ name: string; runAs: string }> = []
  const runner = { runNow: async (entry: IAgentSchedule) => void ran.push({ name: entry.name, runAs: entry.runAs }) } as unknown as ScheduleRunner
  const agentProject = (agentId: string) => ({ 'agente-alfa': 'alfa', 'agente-beta': 'beta' })[agentId]
  const call = callOf(new SchedulesController({ schedules, runner, agentProject, proof }))
  const names = async (as: string, query?: Record<string, string>) =>
    ((await call(as, 'listAll', { query })).body?.result as Array<{ agentId: string; name: string }>).map((entry) => `${entry.agentId}/${entry.name}`).sort()

  it('a visão geral: cada admin vê os escopos dele; o root, só o global', async () => {
    assert.deepStrictEqual(await names(ROOT), ['agente-global/g-global'])
    assert.deepStrictEqual(await names(ANA), ['agente-alfa/diario', 'agente-global/g-alfa'])
    assert.deepStrictEqual(await names(BIA), ['agente-beta/diario'])
    assert.strictEqual((await call(CAIO, 'listAll')).status, 404)
  })

  it('por agente: o do projeto, o admin dele; o global, cada um vê os agendamentos do escopo dele', async () => {
    assert.strictEqual((await call(ANA, 'list', { params: { agentId: 'agente-alfa' } })).status, 200)
    assert.strictEqual((await call(BIA, 'list', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'list', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.deepStrictEqual(
      (await call(ROOT, 'list', { params: { agentId: 'agente-global' } })).body?.result.map((entry: { name: string }) => entry.name),
      ['g-global'],
    )
    assert.deepStrictEqual(
      (await call(ANA, 'list', { params: { agentId: 'agente-global' } })).body?.result.map((entry: { name: string }) => entry.name),
      ['g-alfa'],
    )
  })

  it('⛔ gravar, rodar e ver o histórico: o escopo do agendamento', async () => {
    const on = (agentId: string, name: string) => ({ params: { agentId, scheduleName: name }, body: { name, cron: '0 9 * * *', prompt: 'x' } })
    for (const handler of ['update', 'remove', 'run', 'runs'] as const) {
      assert.notStrictEqual((await call(ANA, handler, on('agente-alfa', 'diario'))).status, 404, `${handler}: a Ana`)
      assert.strictEqual((await call(BIA, handler, on('agente-alfa', 'diario'))).status, 404, `${handler}: a Bia`)
      assert.strictEqual((await call(ROOT, handler, on('agente-alfa', 'diario'))).status, 404, `${handler}: o root`)
      assert.strictEqual((await call(CAIO, handler, on('agente-alfa', 'diario'))).status, 404, `${handler}: o Caio`)
      assert.strictEqual((await call(ANA, handler, on('agente-global', 'g-global'))).status, 404, `${handler}: global, a Ana`)
      assert.notStrictEqual((await call(ROOT, handler, on('agente-global', 'g-global'))).status, 404, `${handler}: global, o root`)
      // O agendamento do agente global que roda no alfa é do alfa.
      assert.notStrictEqual((await call(ANA, handler, on('agente-global', 'g-alfa'))).status, 404, `${handler}: roda no alfa, a Ana`)
      assert.strictEqual((await call(ROOT, handler, on('agente-global', 'g-alfa'))).status, 404, `${handler}: roda no alfa, o root`)
    }
  })

  it('criar: o escopo é o do agente, ou onde o agente global roda; sem lugar, o global', async () => {
    const create = (as: string, agentId: string, projectId?: string) =>
      call(as, 'create', { params: { agentId }, body: { name: 'novo', cron: '0 9 * * *', prompt: 'x', ...(projectId ? { projectId } : {}) } })
    assert.strictEqual((await create(ANA, 'agente-alfa')).status, 201)
    assert.strictEqual((await create(BIA, 'agente-alfa')).status, 404)
    assert.strictEqual((await create(ROOT, 'agente-alfa')).status, 404)
    assert.strictEqual((await create(ANA, 'agente-global', 'alfa')).status, 201)
    assert.strictEqual((await create(ANA, 'agente-global', 'beta')).status, 404)
    assert.strictEqual((await create(ROOT, 'agente-global', 'alfa')).status, 404)
    assert.strictEqual((await create(ANA, 'agente-global')).status, 404)
    assert.strictEqual((await create(ROOT, 'agente-global')).status, 201)
  })

  it('⛔ mudar onde o agendamento do agente global roda pede admin dos dois', async () => {
    const move = (as: string, name: string, projectId: string | null) => call(as, 'update', { params: { agentId: 'agente-global', scheduleName: name }, body: { projectId } })
    assert.strictEqual((await move(ANA, 'g-alfa', 'beta')).status, 404)
    assert.strictEqual((await move(ANA, 'g-alfa', null)).status, 404)
    assert.strictEqual((await move(ROOT, 'g-global', 'alfa')).status, 404)
    assert.strictEqual((await move(ROOT, 'g-global', null)).status, 200)
  })

  it('⛔ "rodar agora" o agendamento de OUTRA pessoa roda como quem pediu, nunca com a credencial do criador', async () => {
    ran.length = 0
    await call(ANA, 'run', { params: { agentId: 'agente-alfa', scheduleName: 'diario' } })
    assert.deepStrictEqual(ran, [{ name: 'diario', runAs: 'u_ana' }])
  })
})
