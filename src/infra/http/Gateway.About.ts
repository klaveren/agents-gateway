import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** O que a tela mostra em "Sobre". */
export interface IGatewayAbout {
  name: string
  version: string
  /** O commit de onde o instalador saiu. Ausente quando quem subiu o servidor não informou (dev, imagem). */
  build?: string
}

let cached: string | undefined

/** A versão do `package.json` que acompanha o código: a raiz do repositório; no app e na imagem, ao lado do `dist`. */
function packageVersion(): string {
  if (cached) return cached
  try {
    const found = (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: unknown }).version
    cached = typeof found === 'string' && found.trim() ? found.trim() : 'desconhecida'
  } catch {
    cached = 'desconhecida'
  }
  return cached
}

/**
 * ⚖️ A versão não muda a cada build (`1.0.0-alpha`); o BUILD muda, e é ele que diz qual instalador está rodando.
 * `GATEWAY_BUILD` vem de quem sobe o servidor (`<versão>+<commit>`, o `CFBundleVersion` do app do Mac): fica só o commit.
 */
export function gatewayAbout(env: NodeJS.ProcessEnv = process.env): IGatewayAbout {
  const raw = env.GATEWAY_BUILD?.trim()
  const build = raw ? raw.slice(raw.indexOf('+') + 1).trim() : undefined
  return { name: 'Agents Gateway', version: packageVersion(), ...(build ? { build } : {}) }
}
