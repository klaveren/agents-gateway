import { randomBytes } from 'node:crypto'
import { HOST_APPROVAL_TIMEOUT_MS, IHostApproval, IHostApprovalAnswer } from '@domain/models/HostApproval.Model'

/** Quem pede e quem responde a aprovação de um comando do agente de máquina (ver `HostApproval.Model`). */
export interface IHostApprovals {
  /** Espera a pessoa: aprovado (com a senha, se pediu), recusado, ou recusado sozinho ao fim do prazo ou do turno. */
  request(input: Omit<IHostApproval, 'id' | 'createdAt' | 'expiresAt'>, signal?: AbortSignal): Promise<IHostApprovalAnswer>
  /** Os pedidos abertos de uma conversa, sem nada secreto. */
  pending(sessionId: string): IHostApproval[]
  /** A resposta da pessoa. `false` = o pedido já não existe (respondido, vencido ou de outra conversa). */
  answer(sessionId: string, id: string, answer: IHostApprovalAnswer): boolean
}

/**
 * 🖥️ Os pedidos em MEMÓRIA: valem enquanto o comando espera. Reiniciar o gateway derruba o turno, e o pedido junto.
 */
export class HostApprovalsService implements IHostApprovals {
  private readonly open = new Map<string, { approval: IHostApproval; settle: (answer: IHostApprovalAnswer) => void }>()

  constructor(
    private readonly timeoutMs: number = HOST_APPROVAL_TIMEOUT_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  request(input: Omit<IHostApproval, 'id' | 'createdAt' | 'expiresAt'>, signal?: AbortSignal): Promise<IHostApprovalAnswer> {
    const createdAt = this.now()
    const approval: IHostApproval = { ...input, id: `ha_${randomBytes(9).toString('base64url')}`, createdAt, expiresAt: new Date(createdAt.getTime() + this.timeoutMs) }
    return new Promise((resolve) => {
      const finish = (answer: IHostApprovalAnswer) => {
        if (!this.open.delete(approval.id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        resolve(answer)
      }
      const aborted = () => finish({ approved: false })
      const timer = setTimeout(() => finish({ approved: false }), this.timeoutMs)
      timer.unref?.()
      this.open.set(approval.id, { approval, settle: finish })
      if (signal?.aborted) aborted()
      else signal?.addEventListener('abort', aborted, { once: true })
    })
  }

  pending(sessionId: string): IHostApproval[] {
    return [...this.open.values()].map((entry) => entry.approval).filter((approval) => approval.sessionId === sessionId)
  }

  answer(sessionId: string, id: string, answer: IHostApprovalAnswer): boolean {
    const entry = this.open.get(id)
    if (!entry || entry.approval.sessionId !== sessionId) return false
    entry.settle(answer.approved ? answer : { approved: false, ...(answer.by ? { by: answer.by } : {}) })
    return true
  }
}
