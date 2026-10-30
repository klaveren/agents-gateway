import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { maskText } from '@domain/Secret.Mask'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { OpencodeDetector } from '@infra/import/Opencode.Detector'
import { readRepoTree } from '@infra/import/Repo.Tree'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { resolveWorkFolder } from '@infra/workspace/Work.Folder'
import { FAKE_TOKEN, gitInit, writeFixture } from '../../testing/Import.Fixture'
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
    controller = new ImportController({
      scan: new ImportScanUseCase({
        readTree: (projectId, repository) => readRepoTree(resolveWorkFolder(folderOf(projectId), repository).dir, { mask: (text) => maskText(text, []) }),
        detectors: [new AgentsDirDetector(), new OpencodeDetector()],
        findInCatalog: () => undefined,
      }),
      projectExists: (projectId) => ['alfa', 'beta'].includes(projectId),
      proof,
    })
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  const call = (as: string, projectId: string, body: unknown) =>
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
      await controller.scan({ params: { id: projectId }, body } as unknown as Request, res)
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
})
