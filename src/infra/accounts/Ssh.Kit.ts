import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Uma identidade SSH do comando (ver `ProjectAccounts.Service`). */
export interface ISshKitIdentity {
  id: string
  privateKey: string
  certificate?: string
  hostPatterns: string[]
  knownHosts: string
}

/** A pasta das contas de UM comando, dentro do HOME do projeto (a que o cerco deixa o comando ler). */
export function accountsDir(home: string, token: string): string {
  return join(home, '.accounts', token.replace(/[^A-Za-z0-9_-]/g, '_'))
}

const SSH_CLIENTS = ['ssh', 'scp', 'sftp'] as const

/** O cliente de verdade: o wrapper precisa do caminho, senão chamaria a si mesmo. */
function realClient(name: string): string | undefined {
  return ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'].map((dir) => join(dir, name)).find((path) => existsSync(path))
}

/**
 * ⛔ O KIT SSH DE UM COMANDO: a chave e o certificado de cada conta, os `known_hosts` aceitos e uma config do ssh, numa
 * pasta só deste comando — que sai no fim dele. Wrappers de `ssh`, `scp` e `sftp` à frente do PATH passam a config
 * (`-F`): o ssh comum passa a sair pela porta do gateway (`ProxyCommand`), só com estas identidades, e recusa o
 * servidor que não está nos `known_hosts` (`StrictHostKeyChecking yes`, nada de aceitar no primeiro uso).
 *
 * ⚠️ Os nomes dos arquivos (`ident-*`) fogem dos padrões que a camada sistema esconde do cerco (`*.key`, `id_ed25519*`):
 * com eles, o próprio ssh não leria a chave.
 */
export function writeSshKit(dir: string, identities: readonly ISshKitIdentity[], proxyCommand: string): { bin: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const knownHosts = join(dir, 'known_hosts')
  writeFileSync(knownHosts, `${identities.map((identity) => identity.knownHosts.trim()).join('\n')}\n`, { mode: 0o600 })
  const blocks = identities.map((identity, index) => {
    const key = join(dir, `ident-${index}`)
    writeFileSync(key, identity.privateKey.endsWith('\n') ? identity.privateKey : `${identity.privateKey}\n`, { mode: 0o600 })
    if (identity.certificate) writeFileSync(`${key}-cert.pub`, `${identity.certificate.trim()}\n`, { mode: 0o600 })
    return [
      `# conta ${identity.id}`,
      `Host ${identity.hostPatterns.length ? identity.hostPatterns.join(' ') : '*'}`,
      `  IdentityFile ${key}`,
      ...(identity.certificate ? [`  CertificateFile ${key}-cert.pub`] : []),
    ].join('\n')
  })
  const config = join(dir, 'config')
  writeFileSync(
    config,
    [
      ...blocks,
      'Host *',
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${knownHosts}`,
      '  GlobalKnownHostsFile /dev/null',
      '  StrictHostKeyChecking yes',
      '  UpdateHostKeys no',
      `  ProxyCommand ${proxyCommand}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  for (const name of SSH_CLIENTS) {
    const real = realClient(name)
    if (real) writeFileSync(join(bin, name), `#!/bin/sh\nexec ${real} -F '${config}' "$@"\n`, { mode: 0o700 })
  }
  // O git por SSH usa o `ssh` do PATH (o wrapper) com o `GIT_SSH_COMMAND` do cerco por cima.
  return { bin }
}

export function removeSshKit(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
