import { EProvider } from './enums/EProvider.Enum'

/**
 * O quanto o cliente agêntico de um provider alcança desta máquina, por agente.
 *
 * - `read-only`: lê, não escreve. É o padrão.
 * - `workspace-write`: escreve no diretório da conversa, que é vazio e um por conversa.
 * - `full`: sem sandbox. Lê, escreve e executa como o processo do gateway, com `.env`, `secrets.key` e o banco.
 *
 * ⚖️ Decisão de quem cria o agente, como as nativas: a tela avisa, e quem decide se o agente é só para
 * admin é a marca `IAgent.adminOnly`.
 */
export type TSandboxLevel = 'read-only' | 'workspace-write' | 'full'

/** Os níveis que cada protocolo tem. O primeiro é o padrão. Sem entrada, o protocolo não tem sandbox para ajustar. */
export const SANDBOX_LEVELS: Readonly<Partial<Record<EProvider, readonly TSandboxLevel[]>>> = {
  // O `sandboxMode` do Codex SDK: `read-only`, `workspace-write` e `danger-full-access`.
  [EProvider.CODEX]: ['read-only', 'workspace-write', 'full'],
  // O `agy` tem `--sandbox` ligado ou desligado. Ligado, nega o que pede permissão.
  [EProvider.ANTIGRAVITY]: ['read-only', 'full'],
}

/** Os protocolos cujo sandbox libera a rede à parte (o `networkAccessEnabled` do Codex). */
export const SANDBOX_NETWORK: readonly EProvider[] = [EProvider.CODEX]

export function sandboxLevelsOf(protocol: EProvider): readonly TSandboxLevel[] {
  return SANDBOX_LEVELS[protocol] ?? []
}

/** O nível que vale: o declarado, se o protocolo o tem; senão o padrão dele. */
export function sandboxOf(protocol: EProvider, declared: TSandboxLevel | undefined): TSandboxLevel {
  const levels = sandboxLevelsOf(protocol)
  return declared && levels.includes(declared) ? declared : (levels[0] ?? 'read-only')
}
