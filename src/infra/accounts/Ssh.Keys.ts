import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { dataDir } from '@infra/adapters/support/Subscription.Workspace'

const run = promisify(execFile)

/** O certificado de UM comando: o par efêmero e o certificado assinado pela CA do projeto. */
export interface ISshIssued {
  privateKey: string
  certificate: string
}

/**
 * ⛔ O `ssh-keygen` DO GATEWAY, fora do cerco: gera a CA do projeto, emite o certificado de minutos de cada comando e
 * assina dados com a chave importada. A chave toca o disco só numa pasta 0700 dentro dos dados do gateway (que o cerco
 * esconde de todo comando), pelo tempo da chamada.
 */
export class SshKeys {
  constructor(
    private readonly keygen = process.env.SSH_KEYGEN_BIN?.trim() || 'ssh-keygen',
    private readonly scratchRoot = () => join(dataDir(), 'ssh-scratch'),
  ) {}

  /** A CA nova de um projeto (ed25519, sem senha): a privada vai para o cofre; a pública, para os servidores. */
  async generateCa(comment: string): Promise<{ privateKey: string; publicKey: string }> {
    return this.inScratch(async (dir) => {
      await run(this.keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', join(dir, 'ca')])
      return { privateKey: readFileSync(join(dir, 'ca'), 'utf8'), publicKey: readFileSync(join(dir, 'ca.pub'), 'utf8').trim() }
    })
  }

  /** A chave pública de uma privada (sem senha). Falha = a chave não abre. */
  async publicOf(privateKey: string): Promise<string> {
    return this.inScratch(async (dir) => {
      writeFileSync(join(dir, 'k'), privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 })
      try {
        return (await run(this.keygen, ['-y', '-P', '', '-f', join(dir, 'k')])).stdout.trim()
      } catch {
        throw new Error('a chave privada SSH não abre (ou tem senha): use uma chave sem senha')
      }
    })
  }

  /**
   * O certificado de um comando: par ed25519 NOVO, assinado pela CA, para os `principals`, valendo de 1 minuto atrás
   * (relógio do servidor atrasado) até `minutes` à frente. O comando vê a chave efêmera, que vence sozinha.
   */
  async issue(caPrivateKey: string, principals: readonly string[], minutes: number, keyId: string): Promise<ISshIssued> {
    return this.inScratch(async (dir) => {
      writeFileSync(join(dir, 'ca'), caPrivateKey.endsWith('\n') ? caPrivateKey : `${caPrivateKey}\n`, { mode: 0o600 })
      await run(this.keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', keyId, '-f', join(dir, 'ident')])
      await run(this.keygen, ['-q', '-s', join(dir, 'ca'), '-I', keyId, '-n', principals.join(','), '-V', `-1m:+${minutes}m`, join(dir, 'ident.pub')])
      return { privateKey: readFileSync(join(dir, 'ident'), 'utf8'), certificate: readFileSync(join(dir, 'ident-cert.pub'), 'utf8').trim() }
    })
  }

  /** O que o certificado diz (`ssh-keygen -L`): o teste da tela. */
  async describeCertificate(certificate: string): Promise<string> {
    return this.inScratch(async (dir) => {
      writeFileSync(join(dir, 'c-cert.pub'), `${certificate}\n`)
      const { stdout } = await run(this.keygen, ['-L', '-f', join(dir, 'c-cert.pub')])
      const field = (name: string) => new RegExp(`^\\s*${name}:\\s*(.*)$`, 'm').exec(stdout)?.[1]?.trim()
      // Os usuários vêm um por linha depois de `Principals:`, até o próximo campo (`Critical Options: …`).
      const lines = stdout.split('\n')
      const start = lines.findIndex((line) => /^\s*Principals:/.test(line))
      const end = lines.findIndex((line, index) => index > start && /^\s*[A-Z][A-Za-z ]+:/.test(line))
      const principals =
        start < 0
          ? ''
          : lines
              .slice(start + 1, end < 0 ? undefined : end)
              .map((line) => line.trim())
              .filter(Boolean)
              .join(', ')
      return `certificado ${field('Type') ?? ''}; usuários ${principals || '?'}; ${field('Valid') ?? ''}`.replace(/\s+/g, ' ')
    })
  }

  /** Assina `data` no formato do `ssh-keygen -Y sign` (SSHSIG), com o `namespace` dado. A chave fica no gateway. */
  async sign(privateKey: string, namespace: string, data: string): Promise<string> {
    return this.inScratch(async (dir) => {
      writeFileSync(join(dir, 'k'), privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 })
      writeFileSync(join(dir, 'data'), data)
      await run(this.keygen, ['-Y', 'sign', '-f', join(dir, 'k'), '-n', namespace, join(dir, 'data')])
      return readFileSync(join(dir, 'data.sig'), 'utf8')
    })
  }

  private async inScratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const root = this.scratchRoot()
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const dir = mkdtempSync(join(root, `${randomBytes(4).toString('hex')}-`))
    try {
      return await work(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
