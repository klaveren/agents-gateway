import assert from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { accountsDir, removeSshKit, writeSshKit } from './Ssh.Kit'

const home = mkdtempSync(join(tmpdir(), 'gw-kit-'))
after(() => rmSync(home, { recursive: true, force: true }))

describe('Ssh.Kit (a pasta SSH de um comando)', () => {
  it('⛔ chave e certificado só deste comando, known_hosts estrito, saída pelo gateway, e tudo sai no fim', () => {
    const dir = accountsDir(home, 'tok/../x')
    assert.ok(dir.startsWith(join(home, '.accounts')) && !dir.includes('..'))
    const { bin } = writeSshKit(
      dir,
      [
        {
          id: 'servidores',
          privateKey: 'CHAVE',
          certificate: 'ssh-ed25519-cert-v01@openssh.com AAAA',
          hostPatterns: ['*.empresa1.com'],
          knownHosts: 'srv.empresa1.com ssh-ed25519 AAAAx',
        },
      ],
      '/node /h/.gateway-connect.cjs %h %p',
    )
    const config = readFileSync(join(dir, 'config'), 'utf8')
    assert.match(config, /Host \*\.empresa1\.com\n {2}IdentityFile .*ident-0\n {2}CertificateFile .*ident-0-cert\.pub/)
    assert.match(config, /StrictHostKeyChecking yes/)
    assert.match(config, /IdentitiesOnly yes/)
    assert.match(config, /ProxyCommand \/node \/h\/\.gateway-connect\.cjs %h %p/)
    assert.strictEqual(statSync(join(dir, 'ident-0')).mode & 0o777, 0o600)
    assert.match(readFileSync(join(bin, 'ssh'), 'utf8'), /exec \S+\/ssh -F '.*config' "\$@"/)
    removeSshKit(dir)
    assert.ok(!existsSync(dir))
  })
})
