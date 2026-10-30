import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { ImportJobService } from '@application/ImportJob.Service'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { maskText } from '@domain/Secret.Mask'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { OpencodeDetector } from '@infra/import/Opencode.Detector'
import { SqliteImportRepository } from '@infra/persistence/Sqlite.ImportRepository'
import { readRepoTree } from '@infra/import/Repo.Tree'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { resolveWorkFolder } from '@infra/workspace/Work.Folder'
import { FAKE_TOKEN, gitInit, writeBatchFixture, writeFixture } from '../../testing/Import.Fixture'
import { ImportController } from './Import.Controller'

/** A rota da varredura: só admin, só repositório do próprio projeto, e nada grava. */
describe('POST /projects/:id/import/scan', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const MEMBER = token('u_ana', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }

  const base = mkdtempSync(join(tmpdir(), 'gw-import-route-'))
  const folderOf = (projectId: string) => join(base, projectId)
  let controller: ImportController
  const stored = new Map<string, string[]>()

  before(() => {
    for (const [project, repository] of [
      ['alfa', 'app'],
      ['beta', 'segredo'],
    ]) {
      const root = join(folderOf(project), 'repositories', repository)
      mkdirSync(root, { recursive: true })
      writeFixture(root, join(base, `fora-${project}`))
      gitInit(root)
    }
    const batch = join(folderOf('alfa'), 'repositories', 'lote')
    mkdirSync(batch, { recursive: true })
    writeBatchFixture(batch)
    gitInit(batch)
    const scan = new ImportScanUseCase({
      readTree: (projectId, repository) => readRepoTree(resolveWorkFolder(folderOf(projectId), repository).dir, { mask: (text) => maskText(text, []) }),
      detectors: [new AgentsDirDetector(), new OpencodeDetector()],
      findInCatalog: () => undefined,
      projectIgnore: (projectId) => stored.get(projectId) ?? [],
    })
    controller = new ImportController({
      scan,
      jobs: new ImportJobService({ repository: new SqliteImportRepository(), scan: (projectId, repository, options) => scan.execute(projectId, repository, options) }),
      projectExists: (projectId) => ['alfa', 'beta'].includes(projectId),
      ignore: {
        get: (projectId) => stored.get(projectId) ?? [],
        set: (projectId, patterns) => (stored.set(projectId, [...patterns]), [...patterns]),
      },
      proof,
    })
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  type THandler = 'scan' | 'plan' | 'getIgnore' | 'setIgnore' | 'listJobs' | 'createJob' | 'getJob' | 'updateItem'
  const call = (as: string, projectId: string, body: unknown, handler: THandler = 'scan', params: Record<string, string> = {}) =>
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
      await controller[handler]({ params: { id: projectId, ...params }, body } as unknown as Request, res)
      return reply
    })

  it('o admin recebe o inventário do repositório do projeto, sem conteúdo nem segredo', async () => {
    const reply = await call(ADMIN, 'alfa', { repository: 'app' })
    assert.strictEqual(reply.status, 200)
    assert.strictEqual(reply.body?.result.repository, 'app')
    assert.ok((reply.body?.result.items as Array<{ key: string }>).some((item) => item.key === 'agent:maya'))
    const json = JSON.stringify(reply.body)
    assert.ok(!json.includes(FAKE_TOKEN))
    assert.ok(!json.includes(base), 'nenhum caminho do servidor')
  })

  it('⛔ quem não é admin recebe 404, como rota inexistente', async () => {
    const reply = await call(MEMBER, 'alfa', { repository: 'app' })
    assert.strictEqual(reply.status, 404)
    assert.strictEqual(reply.body?.result, undefined)
  })

  it('⛔ repositório de outro projeto não existe aqui, nem por caminho relativo', async () => {
    for (const repository of ['segredo', '../../beta/repositories/segredo', '..']) {
      const reply = await call(ADMIN, 'alfa', { repository })
      assert.strictEqual(reply.status, 422, repository)
      assert.strictEqual(reply.body?.details?.[0]?.field, 'repository')
      assert.ok(!JSON.stringify(reply.body).includes(base))
    }
  })

  it('projeto inexistente é 404; corpo sem repositório é 422', async () => {
    assert.strictEqual((await call(ADMIN, 'gama', { repository: 'app' })).status, 404)
    assert.strictEqual((await call(ADMIN, 'alfa', {})).status, 422)
  })

  it('o ignorar do projeto: o admin lê e grava; a varredura aplica o do projeto e o da chamada', async () => {
    assert.deepStrictEqual((await call(ADMIN, 'alfa', undefined, 'getIgnore')).body?.result, { patterns: [] })
    const saved = await call(ADMIN, 'alfa', { patterns: ['.agents/specs'] }, 'setIgnore')
    assert.deepStrictEqual([saved.status, saved.body?.result], [200, { patterns: ['.agents/specs'] }])
    const reply = await call(ADMIN, 'alfa', { repository: 'app', ignore: ['misc'] })
    assert.strictEqual(reply.status, 200)
    assert.deepStrictEqual(reply.body?.result.ignored.patterns, [
      { pattern: '.agents/specs', origin: 'project', files: 2 },
      { pattern: 'misc', origin: 'request', files: 1 },
    ])
    assert.ok(!(reply.body?.result.items as Array<{ kind: string }>).some((item) => item.kind === 'spec'))
    stored.clear()
  })

  it('⛔ o ignorar é só do admin; padrão para fora do repositório é 422', async () => {
    assert.strictEqual((await call(MEMBER, 'alfa', undefined, 'getIgnore')).status, 404)
    assert.strictEqual((await call(MEMBER, 'alfa', { patterns: ['x'] }, 'setIgnore')).status, 404)
    assert.strictEqual(stored.size, 0)
    assert.strictEqual((await call(ADMIN, 'gama', undefined, 'getIgnore')).status, 404)
    const bad = await call(ADMIN, 'alfa', { repository: 'app', ignore: ['../fora'] })
    assert.deepStrictEqual([bad.status, bad.body?.details?.[0]?.field], [422, 'ignore.0'])
    assert.strictEqual((await call(ADMIN, 'alfa', { patterns: 'x' }, 'setIgnore')).status, 422)
  })

  describe('POST /projects/:id/import/plan', () => {
    it('o admin recebe o lote do agente em ordem, com o mapa de ids, o alcance e a estimativa; nada de segredo nem caminho do servidor', async () => {
      const reply = await call(ADMIN, 'alfa', { repository: 'lote', agent: 'ana', prefix: 'akm-' }, 'plan')
      assert.strictEqual(reply.status, 200)
      const plan = reply.body?.result
      assert.strictEqual(plan.agent, 'agent:ana')
      assert.strictEqual(plan.steps[0].phase, 1)
      assert.strictEqual(plan.steps.at(-1).kind, 'trigger')
      assert.ok((plan.idMap as Array<{ key: string; id: string }>).some((entry) => entry.key === 'agent:ana' && entry.id === 'akm-ana'))
      assert.ok(plan.reach.translation.lines.length > 0)
      assert.strictEqual(plan.estimate.conversations, plan.steps.length)
      const json = JSON.stringify(reply.body)
      assert.ok(!json.includes(FAKE_TOKEN))
      assert.ok(!json.includes(base), 'nenhum caminho do servidor')
    })

    it('⛔ quem não é admin recebe 404, como rota inexistente', async () => {
      const reply = await call(MEMBER, 'alfa', { repository: 'lote', agent: 'ana' }, 'plan')
      assert.strictEqual(reply.status, 404)
      assert.strictEqual(reply.body?.result, undefined)
    })

    it('⛔ repositório de outro projeto é 422 no repositório; agente fora do inventário e prefixo inválido, 422 no campo', async () => {
      for (const repository of ['segredo', '../../beta/repositories/segredo']) {
        const reply = await call(ADMIN, 'alfa', { repository, agent: 'maya' }, 'plan')
        assert.deepStrictEqual([reply.status, reply.body?.details?.[0]?.field], [422, 'repository'], repository)
        assert.ok(!JSON.stringify(reply.body).includes(base))
      }
      const agent = await call(ADMIN, 'alfa', { repository: 'lote', agent: 'ninguem' }, 'plan')
      assert.deepStrictEqual([agent.status, agent.body?.details?.[0]?.field], [422, 'agent'])
      const prefix = await call(ADMIN, 'alfa', { repository: 'lote', agent: 'ana', prefix: 'a b' }, 'plan')
      assert.deepStrictEqual([prefix.status, prefix.body?.details?.[0]?.field], [422, 'prefix'])
      assert.strictEqual((await call(ADMIN, 'alfa', { repository: 'lote' }, 'plan')).status, 422)
      assert.strictEqual((await call(ADMIN, 'gama', { repository: 'lote', agent: 'ana' }, 'plan')).status, 404)
    })
  })
  describe('trabalhos de importação (/projects/:id/import/jobs)', () => {
    it('analisar salva o trabalho; a lista e o abrir o devolvem; excluir e reclassificar persistem com autor; reanalisar mantém', async () => {
      const created = await call(ADMIN, 'alfa', { repository: 'app' }, 'createJob')
      assert.strictEqual(created.status, 200)
      const job = created.body?.result
      assert.strictEqual(job.repository, 'app')
      assert.strictEqual(job.latest, true)
      assert.strictEqual(job.by, 'u_root@x.test')
      assert.ok((job.scan.items as Array<{ key: string }>).some((item) => item.key === 'agent:maya'))
      assert.ok((job.states as Array<{ state: string }>).every((entry) => entry.state === 'pending'))
      const json = JSON.stringify(created.body)
      assert.ok(!json.includes(FAKE_TOKEN))
      assert.ok(!json.includes(base), 'nenhum caminho do servidor')

      const list = await call(ADMIN, 'alfa', undefined, 'listJobs')
      assert.deepStrictEqual(
        (list.body?.result as Array<{ id: string }>).map((entry) => entry.id),
        [job.id],
      )

      const skipped = await call(ADMIN, 'alfa', { key: 'agent:maya', state: 'skipped' }, 'updateItem', { job: job.id })
      assert.deepStrictEqual([skipped.status, skipped.body?.result.state, skipped.body?.result.by], [200, 'skipped', 'u_root@x.test'])
      const unknown = (job.scan.items as Array<{ key: string; kind: string }>).find((item) => item.kind !== 'agent')!
      const kind = await call(ADMIN, 'alfa', { key: unknown.key, kind: 'spec' }, 'updateItem', { job: job.id })
      assert.strictEqual(kind.body?.result.kind, unknown.kind === 'spec' ? undefined : 'spec')

      const opened = await call(ADMIN, 'alfa', undefined, 'getJob', { job: job.id })
      assert.strictEqual(opened.status, 200)
      assert.strictEqual((opened.body?.result.states as Array<{ key: string; state: string }>).find((entry) => entry.key === 'agent:maya')?.state, 'skipped')

      const again = await call(ADMIN, 'alfa', { repository: 'app' }, 'createJob')
      assert.strictEqual(again.body?.result.previousId, job.id)
      assert.strictEqual(again.body?.result.reuse.stale.length, 0)
      assert.strictEqual((again.body?.result.states as Array<{ key: string; state: string }>).find((entry) => entry.key === 'agent:maya')?.state, 'skipped')

      // O antigo é registro: não muda.
      const outdated = await call(ADMIN, 'alfa', { key: 'agent:maya', state: 'pending' }, 'updateItem', { job: job.id })
      assert.deepStrictEqual([outdated.status, outdated.body?.code], [409, 'import_job_outdated'])
    })

    it('⛔ quem não é admin recebe 404 em todas, e nada é salvo', async () => {
      const before = (await call(ADMIN, 'beta', undefined, 'listJobs')).body?.result.length
      for (const [handler, body, params] of [
        ['listJobs', undefined, {}],
        ['createJob', { repository: 'segredo' }, {}],
        ['getJob', undefined, { job: 'x' }],
        ['updateItem', { key: 'agent:maya', state: 'skipped' }, { job: 'x' }],
      ] as Array<[THandler, unknown, Record<string, string>]>) {
        const reply = await call(MEMBER, 'beta', body, handler, params)
        assert.strictEqual(reply.status, 404, handler)
        assert.strictEqual(reply.body?.result, undefined)
      }
      assert.strictEqual((await call(ADMIN, 'beta', undefined, 'listJobs')).body?.result.length, before)
    })

    it('⛔ repositório de outro projeto é 422; o trabalho de outro projeto não existe aqui (404)', async () => {
      for (const repository of ['segredo', '../../beta/repositories/segredo', '..']) {
        const reply = await call(ADMIN, 'alfa', { repository }, 'createJob')
        assert.deepStrictEqual([reply.status, reply.body?.details?.[0]?.field], [422, 'repository'], repository)
        assert.ok(!JSON.stringify(reply.body).includes(base))
      }
      const theirs = (await call(ADMIN, 'beta', { repository: 'segredo' }, 'createJob')).body?.result
      assert.strictEqual((await call(ADMIN, 'alfa', undefined, 'getJob', { job: theirs.id })).status, 404)
      assert.strictEqual((await call(ADMIN, 'alfa', { key: 'agent:maya', state: 'skipped' }, 'updateItem', { job: theirs.id })).status, 404)
      assert.ok(!(await call(ADMIN, 'alfa', undefined, 'listJobs')).body?.result.some((entry: { id: string }) => entry.id === theirs.id))
      assert.strictEqual((await call(ADMIN, 'gama', undefined, 'listJobs')).status, 404)
    })

    it('corpo inválido é 422: sem estado nem tipo, estado fora do que a pessoa marca, tipo desconhecido, chave fora do trabalho', async () => {
      const job = (await call(ADMIN, 'alfa', { repository: 'app' }, 'createJob')).body?.result
      for (const body of [{ key: 'agent:maya' }, { key: 'agent:maya', state: 'approved' }, { key: 'agent:maya', kind: 'banana' }, { state: 'skipped' }]) {
        assert.strictEqual((await call(ADMIN, 'alfa', body, 'updateItem', { job: job.id })).status, 422, JSON.stringify(body))
      }
      const missing = await call(ADMIN, 'alfa', { key: 'agent:ninguem', state: 'skipped' }, 'updateItem', { job: job.id })
      assert.deepStrictEqual([missing.status, missing.body?.details?.[0]?.field], [422, 'key'])
    })
  })
})
