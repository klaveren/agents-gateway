import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * O `claude` que o `@anthropic-ai/claude-agent-sdk` traz para ESTA plataforma (o pacote opcional
 * `-<plataforma>-<arquitetura>`). É o mesmo binário das conversas — sem depender de Claude Code instalado.
 */
export function claudeBinary(platform: string = process.platform, arch: string = process.arch): string {
  const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))
  const manifest = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/package.json`)
  return join(dirname(manifest), platform === 'win32' ? 'claude.exe' : 'claude')
}
