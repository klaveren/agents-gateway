import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { writeConnector } from './Project.Sandbox'

describe('o auxiliar do SSH pelo portão (.gateway-connect)', () => {
  const home = mkdtempSync(join(tmpdir(), 'gw-connector-'))
  after(() => rmSync(home, { recursive: true, force: true }))

  it('⛔ recusado: o agente vê o MOTIVO que o portão mandou no corpo, não só "403" (antes achava que era o app)', async () => {
    const proxy = createServer((socket) => {
      socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nProxy-Authenticate: Basic\r\n\r\n10.10.0.1 é rede local: só com regra exata\n'))
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const port = (proxy.address() as { port: number }).port
    try {
      const connector = writeConnector(home)
      const child = spawn(process.execPath, [connector, '10.10.0.1', '22'], { env: { HTTPS_PROXY: `http://tok:x@127.0.0.1:${port}` } })
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      assert.strictEqual(code, 1)
      assert.match(stderr, /10\.10\.0\.1:22 recusada \(HTTP\/1\.1 403 Forbidden\): 10\.10\.0\.1 é rede local: só com regra exata/)
    } finally {
      proxy.close()
    }
  })
})
