/**
 * 🖥️ O PEDIDO DE APROVAÇÃO do agente de máquina: um comando que o cerco recusa sempre (o `sudo`, o que apaga ou desliga a
 * máquina) para no meio do turno e espera a pessoa da conversa. Aprovado, roda FORA do cerco, como ela no terminal; com
 * `sudo`, com a senha que ela digitar. ⛔ A senha só entra: vai para o `sudo` e some, nunca volta pela API nem fica guardada.
 */
export interface IHostApproval {
  id: string
  sessionId: string
  agentId?: string
  projectId?: string
  /** O comando exato, como vai rodar (mascarado na tela). */
  command: string
  /** Por que o cerco recusa (a trava que pegou). */
  reason: string
  /** O comando usa `sudo`: a aprovação pede a senha da máquina. */
  password: boolean
  createdAt: Date
  expiresAt: Date
}

export interface IHostApprovalAnswer {
  approved: boolean
  /** Só com `password` e aprovado. */
  password?: string
  by?: string
}

/** Quanto o comando espera a pessoa antes de desistir. */
export const HOST_APPROVAL_TIMEOUT_MS = 5 * 60_000
