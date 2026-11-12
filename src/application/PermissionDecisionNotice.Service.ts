import { IPermissionRequestView, itemLine } from './PermissionRequests.Service'

/** Entrega um texto numa conversa: na fila do turno rodando, ou num turno novo. Lança quando não entrou. */
export type TNoticeDelivery = (conversationId: string, text: string) => Promise<unknown>

export interface IPermissionDecisionNoticeDeps {
  /**
   * ⛔ Chamado NA DECISÃO (dentro da requisição de quem decidiu): devolve a entrega amarrada a essa pessoa. O aviso sai
   * depois, fora da requisição, e a entrega confere se a conversa é dela (ver `AgentController.serverNotice`).
   */
  delivery(): TNoticeDelivery
  /** Quanto esperar por mais decisões da mesma conversa antes de avisar: o "Aprovar todos" vira UM aviso. */
  delayMs?: number
  /** O teto dessa espera, contado da primeira decisão do aviso. */
  maxDelayMs?: number
  /** A segunda (e última) tentativa, quando a primeira não entrou (a fila do turno cheia, um turno começando). */
  retryMs?: number
}

interface IPendingNotice {
  by: string
  decided: IPermissionRequestView[]
  deliver: TNoticeDelivery
  since: number
  timer: NodeJS.Timeout
}

/**
 * ⚖️ A DECISÃO VOLTA À CONVERSA QUE PEDIU: aprovado ou recusado na tela, o agente fica sabendo ali mesmo, sem a pessoa
 * ter de avisar e sem ele ficar perguntando. As decisões de uma conversa que chegam juntas saem num aviso só.
 * ⛔ O texto leva o que o GATEWAY sabe do pedido (o item, o número, a nota de quem decidiu), nunca o motivo escrito por
 * quem pediu: ele é texto livre de um agente e entraria noutra conversa como instrução.
 * ⚠️ É cortesia: o que não entrou (a conversa é de outra pessoa, sumiu, o gateway caiu antes) fica só no log — o estado
 * do pedido continua na tela e em `list_permission_rules`.
 */
export class PermissionDecisionNoticeService {
  private readonly waiting = new Map<string, IPendingNotice>()
  private readonly delayMs: number
  private readonly maxDelayMs: number
  private readonly retryMs: number

  constructor(private readonly deps: IPermissionDecisionNoticeDeps) {
    this.delayMs = deps.delayMs ?? 1500
    this.maxDelayMs = deps.maxDelayMs ?? 15000
    this.retryMs = deps.retryMs ?? 20000
  }

  /** O ouvinte das decisões (ver `PermissionRequestsService.useDecisionListener`). Pedido sem conversa: nada a avisar. */
  decided(request: IPermissionRequestView, decider: { by: string }): void {
    const conversationId = request.requestedBy.conversationId
    if (!conversationId || (request.status !== 'approved' && request.status !== 'rejected')) return
    const now = Date.now()
    const open = this.waiting.get(conversationId)
    if (open) clearTimeout(open.timer)
    const since = open?.since ?? now
    const wait = Math.max(0, Math.min(this.delayMs, since + this.maxDelayMs - now))
    const timer = setTimeout(() => this.flush(conversationId), wait)
    timer.unref()
    // A entrega é a da decisão mais recente: é quem decidiu por último que responde por ela.
    this.waiting.set(conversationId, { by: decider.by, decided: [...(open?.decided ?? []), request], deliver: this.deps.delivery(), since, timer })
  }

  private flush(conversationId: string): void {
    const notice = this.waiting.get(conversationId)
    if (!notice) return
    this.waiting.delete(conversationId)
    const text = decisionNotice(notice.decided, notice.by)
    void this.send(conversationId, text, notice.deliver, true)
  }

  private async send(conversationId: string, text: string, deliver: TNoticeDelivery, again: boolean): Promise<void> {
    try {
      await deliver(conversationId, text)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!again) return console.warn(`[pedidos de permissão] o aviso da decisão não entrou na conversa ${conversationId}:`, reason)
      const timer = setTimeout(() => void this.send(conversationId, text, deliver, false), this.retryMs)
      timer.unref()
    }
  }
}

/** O texto do aviso: o que foi aprovado, o que foi recusado e o que o agente faz com isso. */
export function decisionNotice(decided: readonly IPermissionRequestView[], by: string): string {
  const line = (request: IPermissionRequestView) => `• ${itemLine(request)} (pedido ${request.id})`
  const approved = decided.filter((request) => request.status === 'approved')
  const rejected = decided.filter((request) => request.status === 'rejected')
  return [
    `[Aviso do gateway, não é mensagem da pessoa: ${by} decidiu pedidos de permissão feitos nesta conversa.]`,
    ...(approved.length ? ['', 'Aprovados (já valem):', ...approved.map(line)] : []),
    ...(rejected.length
      ? ['', 'Recusados (não valem):', ...rejected.map((request) => `${line(request)}${request.decisionNote ? ` — nota de quem recusou: ${request.decisionNote}` : ''}`)]
      : []),
    '',
    [
      approved.length
        ? 'Regra aprovada vale já. Ferramenta, MCP ou delegação ligada agora pode não aparecer nesta conversa, que segue com as que tinha ao abrir: se não aparecer, diga à pessoa que é preciso uma conversa nova.'
        : '',
      rejected.length ? 'Não peça de novo o que foi recusado sem um motivo novo; siga por outro caminho ou diga à pessoa o que ficou sem fazer.' : '',
      'Se a tarefa que dependia disso continua em aberto, siga de onde parou; se não, confirme em uma linha.',
    ]
      .filter(Boolean)
      .join(' '),
  ].join('\n')
}
