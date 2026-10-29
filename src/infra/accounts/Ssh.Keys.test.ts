import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { SshKeys } from './Ssh.Keys'

const scratch = mkdtempSync(join(tmpdir(), 'gw-ssh-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const keys = new SshKeys('ssh-keygen', () => join(scratch, 'work'))

describe('SshKeys (ssh-keygen do gateway)', () => {
  it('⛔ a CA emite um certificado de minutos, só para os usuários dados; nada fica no disco depois', async () => {
    const ca = await keys.generateCa('gateway-ca:p1:servidores')
    assert.match(ca.publicKey, /^ssh-ed25519 AAAA\S+ gateway-ca:p1:servidores$/)
    assert.match(ca.privateKey, /BEGIN OPENSSH PRIVATE KEY/)

    const issued = await keys.issue(ca.privateKey, ['deploy', 'app'], 5, 'gateway:p1:servidores:comando')
    assert.match(issued.certificate, /^ssh-ed25519-cert-v01@openssh\.com /)
    const cert = join(scratch, 'c-cert.pub')
    writeFileSync(cert, `${issued.certificate}\n`)
    const listed = execFileSync('ssh-keygen', ['-L', '-f', cert]).toString()
    assert.match(listed, /Principals:\s*\n\s*deploy\s*\n\s*app/)
    assert.match(listed, /Signing CA: ED25519/)
    const [from, to] = /Valid: from (\S+) to (\S+)/
      .exec(listed)!
      .slice(1)
      .map((value) => new Date(value).getTime())
    assert.ok(to - from <= 6 * 60_000 + 1000, 'de 1 min atrás até 5 min à frente')
    assert.match(await keys.describeCertificate(issued.certificate), /usuários deploy, app; from /)
    assert.deepStrictEqual(readdirSync(join(scratch, 'work')), [])
  })

  it('assina no formato SSHSIG, e a assinatura confere com a chave pública', async () => {
    const ca = await keys.generateCa('chave-importada')
    const signature = await keys.sign(ca.privateKey, 'token', 'conteúdo a assinar')
    assert.match(signature, /BEGIN SSH SIGNATURE/)
    const signers = join(scratch, 'allowed')
    const sig = join(scratch, 'data.sig')
    writeFileSync(signers, `quem ${ca.publicKey}\n`)
    writeFileSync(sig, signature)
    const verified = execFileSync('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', 'quem', '-n', 'token', '-s', sig], { input: 'conteúdo a assinar' }).toString()
    assert.match(verified, /Good "token" signature for quem/)
    assert.strictEqual(await keys.publicOf(ca.privateKey), ca.publicKey.split(' ').slice(0, 2).join(' ') + ' chave-importada')
    await assert.rejects(keys.publicOf('-----BEGIN OPENSSH PRIVATE KEY-----\nxx\n-----END OPENSSH PRIVATE KEY-----'), /não abre/)
  })
})
