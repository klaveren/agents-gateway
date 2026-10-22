import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const VERSION = 'v1'

/**
 * Fecha e abre segredo com AES-256-GCM: IV aleatório por segredo, e a etiqueta de autenticação junto
 * — conteúdo adulterado ou chave-mestra errada FALHAM ao abrir, em vez de devolver lixo.
 *
 * Formato: `v1.<iv>.<tag>.<cifrado>`, em base64url.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('A chave-mestra precisa ter 32 bytes')
  }

  seal(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])

    return [VERSION, iv, cipher.getAuthTag(), sealed].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.')
  }

  /** `undefined` para o que não abre — formato estranho, adulterado ou fechado com outra chave. */
  open(box: string): string | undefined {
    try {
      const [version, iv, tag, sealed] = box.split('.')
      if (version !== VERSION || !iv || !tag || !sealed) return undefined

      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(sealed, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      return undefined
    }
  }
}

/**
 * A chave-mestra: `SECRETS_KEY` (32 bytes em base64 ou hex) ou, sem ela, um arquivo gerado uma vez.
 *
 * ⛔ NÃO MORA NO BANCO. Guardar a chave ao lado do que ela fecha faria de uma cópia do `gateway.db`
 * uma cópia das chaves de API. O arquivo nasce com permissão 0600 (só o dono do processo lê).
 *
 * ⚠️ Perder o arquivo (ou trocar `SECRETS_KEY`) não derruba nada: as chaves salvas ficam ilegíveis,
 * a tela avisa, e basta colá-las de novo. As do `.env` continuam valendo.
 */
export function masterKey(keyFile: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = env.SECRETS_KEY?.trim()
  if (configured) {
    const key = /^[0-9a-f]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64')
    if (key.length !== 32) throw new Error('SECRETS_KEY precisa ter 32 bytes (64 hex ou 44 base64)')
    return key
  }

  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64')

  mkdirSync(dirname(keyFile), { recursive: true })
  const key = randomBytes(32)
  writeFileSync(keyFile, key.toString('base64'), { mode: 0o600, flag: 'wx' })
  chmodSync(keyFile, 0o600)
  return key
}
