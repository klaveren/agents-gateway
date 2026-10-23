import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'

/**
 * O id de sessão carrega a rota: `<provider>-<mode>-<uuid>`.
 *
 * É o que permite `sendMessage` e `cancel` encontrarem o adapter certo a partir do id
 * sozinho, sem um mapa paralelo de sessão para lane vivendo em outro lugar.
 */
export function sessionPrefix(provider: EProvider, mode: EMode): string {
  // O hífen separa as partes: `claude-sub` vira `claudesub`, senão o modo seria lido como `sub`.
  return `${provider.replace(/-/g, '')}-${mode}`
}

export function readMode(sessionId: string): EMode | undefined {
  const mode = sessionId.split('-')[1]
  return Object.values(EMode).find((value) => value === mode)
}

export function readProvider(sessionId: string): EProvider | undefined {
  const provider = sessionId.split('-')[0]
  return Object.values(EProvider).find((value) => value.replace(/-/g, '') === provider)
}
