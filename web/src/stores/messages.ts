import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'

/** 💬 Uma mensagem de um fio (ver `PersonMessage.Model` no servidor). */
export interface IPersonMessage {
  id: string
  conversationId: string
  projectId?: string
  agentId: string
  from: 'agent' | 'person'
  authorId?: string
  title?: string
  body: string
  level: 'info' | 'attention' | 'urgent'
  turn?: number
  createdAt: string
  readAt?: string
  /** Só no pedido (`attention`/`urgent`): pendente, respondido ou resolvido. */
  status?: 'pending' | 'answered' | 'resolved'
  answeredAt?: string
  /** Na resposta da pessoa: o id do pedido a que ela respondeu. */
  replyTo?: string
}

/** Uma resposta da pessoa a caminho (ver `outbox`). `confirmed`: o fio já a trouxe do servidor (a bolha dela é a de lá). */
export interface IOutgoingReply {
  id: string
  key: string
  body: string
  replyTo?: string
  createdAt: string
  state: 'sending' | 'sent' | 'failed'
  error?: string
  queued?: boolean
  confirmed?: boolean
  /** Quantas mensagens do agente o item tinha quando ela foi: chegou mais uma, ele respondeu. */
  agentsBefore?: number
}

/**
 * 🔑 O item a que a mensagem pertence (o mesmo `messageKeyOf` do servidor): o pedido é o próprio item; a resposta a ele
 * (da pessoa ou o retorno do agente) vai para o item dele; o resto, para o item da conversa.
 */
export function messageKeyOf(message: Pick<IPersonMessage, 'id' | 'from' | 'status' | 'replyTo' | 'conversationId'>): string {
  if (message.from === 'agent' && message.status) return message.id
  return message.replyTo ?? message.conversationId
}

/** 💬 Um item da caixa: um pedido do agente (com as respostas) ou os avisos de uma conversa. */
export interface IPersonThread {
  /** O id do item: o do pedido ou o da conversa. */
  id: string
  /** No item de pedido: o id do pedido. */
  requestId?: string
  conversationId: string
  agentId: string
  projectId?: string
  title?: string
  last: IPersonMessage
  unread: number
  /** Quantos pedidos do fio ainda estão pendentes. */
  pending: number
  archived: boolean
  /** 🔌 Só nos itens de um projeto conectado: a conversa mora na origem (`stale`: a origem não respondeu, é a última lista). */
  origin?: { projectId: string; url: string; stale?: boolean }
}

/**
 * 💬 A CAIXA DE MENSAGENS da pessoa: os itens (um por pedido; os avisos, um por conversa), o total não lido (o selo da navegação) e
 * o fio aberto. O stream da caixa de entrada avisa (`message.created`) e a lista se relê.
 */
export const useMessagesStore = defineStore('messages', () => {
  const threads = ref<IPersonThread[]>([])
  const unread = ref(0)
  const pending = ref(0)
  const archived = ref(false)
  const loaded = ref(false)
  /** O item aberto: o id dele, a conversa de origem e as mensagens só dele. */
  const open = ref<{ key: string; conversationId: string; messages: IPersonMessage[] }>()

  async function load(): Promise<void> {
    const result = await api<{ threads: IPersonThread[]; unread: number; pending?: number }>('/messages', { query: archived.value ? { archived: 1 } : {} })
    threads.value = result.threads
    unread.value = result.unread
    pending.value = result.pending ?? 0
    loaded.value = true
  }

  /**
   * 👀 A pessoa está OLHANDO a tela: aba visível e janela em foco. ⚖️ Mensagem que chega com o fio aberto numa janela de
   * fundo (outra aba, o app do Mac atrás de outro) fica NÃO LIDA: o selo avisa, e ela vira lida quando a pessoa volta.
   */
  const looking = () => typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus())

  async function openThread(key: string, markRead = true): Promise<void> {
    const result = await api<{ messages: IPersonMessage[] }>(`/messages/${encodeURIComponent(key)}`)
    // O id da conversa traz a conversa inteira: o item dela é só o que não é de pedido.
    const messages = result.messages.filter((message) => messageKeyOf(message) === key)
    open.value = { key, conversationId: result.messages[0]?.conversationId ?? key, messages }
    settleOutbox()
    if (markRead && messages.some((message) => message.from === 'agent' && !message.readAt)) {
      const read = await api<{ unread: number }>(`/messages/${encodeURIComponent(key)}/read`, { method: 'POST' })
      unread.value = read.unread
      threads.value = threads.value.map((thread) => (thread.id === key ? { ...thread, unread: 0 } : thread))
    }
  }

  /**
   * 📤 As respostas que a pessoa mandou desta tela, antes de o fio as trazer do servidor: entram NA HORA (enviando), e a
   * enviada segue esperando a resposta do agente (os três pontos) até chegar uma mensagem dele no item. ⚖️ Só na memória:
   * o fio gravado é a verdade; isto é o que ainda não chegou nele.
   */
  const outbox = ref<IOutgoingReply[]>([])
  let outgoingSeq = 0
  const agentCount = (key: string) => (open.value?.key === key ? open.value.messages.filter((message) => message.from === 'agent').length : undefined)
  function patchOutgoing(id: string, patch: Partial<IOutgoingReply>): void {
    outbox.value = outbox.value.map((item) => (item.id === id ? { ...item, ...patch } : item))
  }
  /**
   * O fio do item foi relido: a enviada já está nele (a bolha passa a ser a do servidor) e, se o agente respondeu depois
   * dela, sai de vez. Sem a contagem de antes (foi mandada com outro item aberto), não há o que esperar: sai também.
   */
  function settleOutbox(): void {
    const current = open.value
    if (!current) return
    const agents = current.messages.filter((message) => message.from === 'agent').length
    outbox.value = outbox.value
      .filter((item) => item.key !== current.key || item.state !== 'sent' || (item.agentsBefore !== undefined && agents <= item.agentsBefore))
      .map((item) => (item.key === current.key && item.state === 'sent' ? { ...item, confirmed: true } : item))
  }
  /** Tira da tela a que falhou (o texto já voltou para a caixa). */
  function dismissOutgoing(id: string): void {
    outbox.value = outbox.value.filter((item) => item.id !== id)
  }

  /** Responde pela caixa; com `replyTo`, é a resposta a UM pedido (que vira respondido). */
  async function reply(key: string, message: string, replyTo?: string): Promise<{ queued: boolean }> {
    // A que falhou antes no mesmo item sai: a pessoa está mandando de novo.
    const item: IOutgoingReply = { id: `local-${++outgoingSeq}`, key, body: message, replyTo, createdAt: new Date().toISOString(), state: 'sending' }
    outbox.value = [...outbox.value.filter((other) => other.key !== key || other.state !== 'failed'), item]
    let result: { queued: boolean }
    try {
      result = await api<{ queued: boolean }>(`/messages/${encodeURIComponent(key)}/reply`, {
        method: 'POST',
        body: replyTo ? { message, replyTo } : { message },
      })
    } catch (failure) {
      patchOutgoing(item.id, { state: 'failed', error: failure instanceof Error ? failure.message : String(failure) })
      throw failure
    }
    patchOutgoing(item.id, { state: 'sent', queued: result.queued, agentsBefore: agentCount(key) })
    // ⚠️ Já foi: a releitura que falhar não desfaz o envio (devolver o texto faria a pessoa mandar duas vezes).
    await Promise.all([openThread(key), load()]).catch(() => undefined)
    return result
  }

  /** 📌 Dá o pedido por tratado (`resolved`) ou o reabre (`pending`); o estado local muda sem reler tudo. */
  async function setStatus(key: string, messageId: string, status: 'resolved' | 'pending'): Promise<void> {
    const result = await api<{ status: 'resolved' | 'pending'; pending: number }>(`/messages/${encodeURIComponent(key)}/${encodeURIComponent(messageId)}/status`, {
      method: 'PUT',
      body: { status },
    })
    pending.value = result.pending
    if (open.value?.key === key) {
      open.value = {
        ...open.value,
        messages: open.value.messages.map((message) =>
          message.id === messageId ? { ...message, status: result.status, ...(result.status === 'pending' ? { answeredAt: undefined } : {}) } : message,
        ),
      }
    }
    threads.value = threads.value.map((thread) => (thread.id === messageId ? { ...thread, pending: result.status === 'pending' ? 1 : 0 } : thread))
  }

  async function archive(key: string, value = true): Promise<void> {
    const result = await api<{ unread: number }>(`/messages/${encodeURIComponent(key)}/archive`, { method: 'PUT', body: { archived: value } })
    unread.value = result.unread
    threads.value = threads.value.filter((thread) => thread.id !== key)
  }

  async function showArchived(value: boolean): Promise<void> {
    archived.value = value
    await load()
  }

  /** O stream avisou: uma mensagem chegou (ou foi lida em outro aparelho). O fio aberto também se relê. */
  function changed(event: { conversationId: string; unread: number }): void {
    unread.value = event.unread
    void load().catch(() => undefined)
    // Sem id de conversa (aviso de projeto conectado): o fio aberto, que pode ser da origem, também se relê.
    if (open.value && (!event.conversationId || open.value.conversationId === event.conversationId)) void openThread(open.value.key, looking()).catch(() => undefined)
  }

  /** A pessoa voltou à janela com o fio aberto: o que chegou enquanto ela estava fora vira lido agora. */
  function returned(): void {
    const current = open.value
    if (!current || !looking() || !current.messages.some((message) => message.from === 'agent' && !message.readAt)) return
    void openThread(current.key).catch(() => undefined)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', returned)
    document.addEventListener('visibilitychange', returned)
  }

  function reset(): void {
    threads.value = []
    unread.value = 0
    pending.value = 0
    open.value = undefined
    outbox.value = []
    loaded.value = false
  }

  const waiting = computed(() => threads.value.filter((thread) => thread.unread > 0).length)

  return { threads, unread, pending, archived, loaded, open, waiting, outbox, load, openThread, reply, dismissOutgoing, setStatus, archive, showArchived, changed, reset }
})
