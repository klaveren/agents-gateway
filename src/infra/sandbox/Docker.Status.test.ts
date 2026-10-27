import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { dockerStatus } from './Docker.Sandbox'

describe('dockerStatus', () => {
  it('sem o cliente docker no PATH: indisponível, dizendo por quê; e a resposta fica guardada por 30s', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gw-no-docker-'))
    const path = process.env.PATH
    process.env.PATH = empty
    try {
      const at = Date.now() + 10 * 60_000
      const status = await dockerStatus(at)
      assert.deepStrictEqual(status, { available: false, reason: 'cliente docker não instalado neste servidor' })
      assert.strictEqual(dockerStatus(at + 1_000), dockerStatus(at + 29_000))
    } finally {
      process.env.PATH = path
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
