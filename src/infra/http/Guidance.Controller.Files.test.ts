import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { GuidanceService } from '@application/Guidance.Service'
import { maskText } from '@domain/Secret.Mask'
import { IResourceFile } from '@domain/models/ResourceFile.Model'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { ResourceFilesStore } from '@infra/workspace/Resource.Files'
import { GuidanceController } from './Guidance.Controller'
import { useProjectAccess } from './Project.Access'

/** As rotas dos arquivos de recurso: enviar o conteúdo, lê-lo de volta e trocar a lista de uma skill ou agente — só admin. */
describe('arquivos de recurso (/files, /resources/:id/files, /agents/:id/files)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const MEMBER = token('u_ana', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const data = mkdtempSync(join(tmpdir(), 'gw-files-route-'))
  after(() => rmSync(data, { recursive: true, force: true }))
  const files = new ResourceFilesStore({ CONVERSATIONS_DB: join(data, 'gateway.db') })
  const guidance = new GuidanceService(new SqliteGuidanceRepository(':memory:'), () => true)
  guidance.useFiles(files)
  const agentCalls: Array<{ id: string; files: IResourceFile[]; by: string }> = []
  const controller = new GuidanceController({
    guidance,
    proof,
    files,
    agentFiles: (id, list, by) => agentCalls.push({ id, files: list, by }),
    secretsIn: (text) => (maskText(text, []) === text ? [] : ['token']),
  })

  type THandler = 'uploadFile' | 'readFile' | 'setResourceFiles' | 'setAgentFiles'
  const call = (as: string, handler: THandler, input: { params?: Record<string, string>; body?: unknown } = {}) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: { status: number; body?: { ok: boolean; result?: any; details?: any } } = { status: 0 } // eslint-disable-line @typescript-eslint/no-explicit-any
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
      await controller[handler]({ params: input.params ?? {}, body: input.body } as unknown as Request, res)
      return reply
    })
  const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64')

  it('enviar: guarda e devolve sha256 e tamanho; lê de volta como texto', async () => {
    const sent = await call(ADMIN, 'uploadFile', { body: { content: b64('#!/bin/sh\necho saldo\n') } })
    assert.deepStrictEqual([sent.status, sent.body?.result.bytes], [200, 21])
    const read = await call(ADMIN, 'readFile', { params: { sha256: sent.body?.result.sha256 } })
    assert.deepStrictEqual([read.status, read.body?.result.text], [200, '#!/bin/sh\necho saldo\n'])
    assert.strictEqual((await call(ADMIN, 'readFile', { params: { sha256: 'f'.repeat(64) } })).status, 404)
  })

  it('⛔ enviar recusa binário e segredo, com o motivo; quem não é admin recebe 404', async () => {
    const binary = await call(ADMIN, 'uploadFile', { body: { content: b64(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1])) } })
    assert.deepStrictEqual([binary.status, /only text/.test(JSON.stringify(binary.body))], [422, true])
    const secret = await call(ADMIN, 'uploadFile', { body: { content: b64('const key = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"\n') } })
    assert.deepStrictEqual([secret.status, /looks like a secret/.test(JSON.stringify(secret.body))], [422, true])
    assert.strictEqual((await call(MEMBER, 'uploadFile', { body: { content: b64('x') } })).status, 404)
  })

  it('a lista da skill: só os arquivos mudam, a pasta é escrita; conteúdo não enviado é 422', async () => {
    guidance.createResource({ id: 'banco', kind: 'skill', description: 'Banco', body: 'Use os scripts.' }, 'root')
    const sent = (await call(ADMIN, 'uploadFile', { body: { content: b64('echo saldo\n') } })).body?.result
    const listed = await call(ADMIN, 'setResourceFiles', { params: { id: 'banco' }, body: { files: [{ path: 'scripts/saldo.sh', ...sent }] } })
    assert.deepStrictEqual([listed.status, listed.body?.result.body, listed.body?.result.files.length], [200, 'Use os scripts.', 1])
    assert.strictEqual(readFileSync(join(data, 'global', 'skills', 'banco', 'scripts', 'saldo.sh'), 'utf8'), 'echo saldo\n')
    const missing = await call(ADMIN, 'setResourceFiles', { params: { id: 'banco' }, body: { files: [{ path: 'x.sh', sha256: 'e'.repeat(64), bytes: 1 }] } })
    assert.strictEqual(missing.status, 422)
  })

  it('a lista do agente vai ao catálogo de agentes, com quem gravou', async () => {
    const reply = await call(ADMIN, 'setAgentFiles', { params: { agentId: 'maya' }, body: { files: [] } })
    assert.deepStrictEqual([reply.status, agentCalls.at(-1)], [200, { id: 'maya', files: [], by: 'u_root@x.test' }])
  })
})

describe('GET /files/:sha256 — o admin de um projeto não lê o arquivo de outro pelo hash', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ANA = token('u_ana', 'member')
  const BIA = token('u_bia', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, Record<string, 'admin' | 'member'>> = { alfa: { u_ana: 'admin' }, beta: { u_bia: 'admin' } }
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
  const data = mkdtempSync(join(tmpdir(), 'gw-files-owner-'))
  after(() => rmSync(data, { recursive: true, force: true }))
  const files = new ResourceFilesStore({ CONVERSATIONS_DB: join(data, 'gateway.db') })
  const put = (text: string) => files.put(Buffer.from(text)).sha256
  const doAlfa = put('segredo do alfa')
  const doGlobal = put('do global')
  const solto = put('ainda solto')
  const controller = new GuidanceController({
    guidance: new GuidanceService(new SqliteGuidanceRepository(':memory:'), () => true),
    proof,
    files,
    fileOwners: (sha256) => (sha256 === doAlfa ? ['alfa'] : sha256 === doGlobal ? [null] : []),
  })
  const read = (as: string, sha256: string) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply = { status: 0 }
      const res = { status: (code: number) => ((reply.status = code), res), json: () => res } as unknown as Response
      await controller.readFile({ params: { sha256 }, body: {}, query: {} } as unknown as Request, res)
      return reply.status
    })

  it('⛔ o dono do escopo lê; o admin de outro projeto, 404; o global e o ainda solto passam', async () => {
    assert.strictEqual(await read(ANA, doAlfa), 200)
    assert.strictEqual(await read(BIA, doAlfa), 404)
    assert.strictEqual(await read(BIA, doGlobal), 200)
    assert.strictEqual(await read(BIA, solto), 200)
  })
})
