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
}

/** 💬 Um fio: a conversa que escreveu, a última mensagem e quantas não lidas. */
export interface IPersonThread {
  conversationId: string
  agentId: string
  projectId?: string
  title?: string
  last: IPersonMessage
  unread: number
  archived: boolean
}

/**
 * 💬 A CAIXA DE MENSAGENS da pessoa: os fios (um por conversa que lhe escreveu), o total não lido (o selo da navegação) e
 * o fio aberto. O stream da caixa de entrada avisa (`message.created`) e a lista se relê.
 */
export const useMessagesStore = defineStore('messages', () => {
  const threads = ref<IPersonThread[]>([])
  const unread = ref(0)
  const archived = ref(false)
  const loaded = ref(false)
  const open = ref<{ conversationId: string; messages: IPersonMessage[] }>()

  async function load(): Promise<void> {
    const result = await api<{ threads: IPersonThread[]; unread: number }>('/messages', { query: archived.value ? { archived: 1 } : {} })
    threads.value = result.threads
    unread.value = result.unread
    loaded.value = true
  }

  /**
   * 👀 A pessoa está OLHANDO a tela: aba visível e janela em foco. ⚖️ Mensagem que chega com o fio aberto numa janela de
   * fundo (outra aba, o app do Mac atrás de outro) fica NÃO LIDA: o selo avisa, e ela vira lida quando a pessoa volta.
   */
  const looking = () => typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus())

  async function openThread(conversationId: string, markRead = true): Promise<void> {
    const { messages } = await api<{ messages: IPersonMessage[] }>(`/messages/${encodeURIComponent(conversationId)}`)
    open.value = { conversationId, messages }
    if (markRead && messages.some((message) => message.from === 'agent' && !message.readAt)) {
      const read = await api<{ unread: number }>(`/messages/${encodeURIComponent(conversationId)}/read`, { method: 'POST' })
      unread.value = read.unread
      threads.value = threads.value.map((thread) => (thread.conversationId === conversationId ? { ...thread, unread: 0 } : thread))
    }
  }

  async function reply(conversationId: string, message: string): Promise<{ queued: boolean }> {
    const result = await api<{ queued: boolean }>(`/messages/${encodeURIComponent(conversationId)}/reply`, { method: 'POST', body: { message } })
    await Promise.all([openThread(conversationId), load()])
    return result
  }

  async function archive(conversationId: string, value = true): Promise<void> {
    const result = await api<{ unread: number }>(`/messages/${encodeURIComponent(conversationId)}/archive`, { method: 'PUT', body: { archived: value } })
    unread.value = result.unread
    threads.value = threads.value.filter((thread) => thread.conversationId !== conversationId)
  }

  async function showArchived(value: boolean): Promise<void> {
    archived.value = value
    await load()
  }

  /** O stream avisou: uma mensagem chegou (ou foi lida em outro aparelho). O fio aberto também se relê. */
  function changed(event: { conversationId: string; unread: number }): void {
    unread.value = event.unread
    void load().catch(() => undefined)
    if (open.value?.conversationId === event.conversationId) void openThread(event.conversationId, looking()).catch(() => undefined)
  }

  /** A pessoa voltou à janela com o fio aberto: o que chegou enquanto ela estava fora vira lido agora. */
  function returned(): void {
    const current = open.value
    if (!current || !looking() || !current.messages.some((message) => message.from === 'agent' && !message.readAt)) return
    void openThread(current.conversationId).catch(() => undefined)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', returned)
    document.addEventListener('visibilitychange', returned)
  }

  function reset(): void {
    threads.value = []
    unread.value = 0
    open.value = undefined
    loaded.value = false
  }

  const waiting = computed(() => threads.value.filter((thread) => thread.unread > 0).length)

  return { threads, unread, archived, loaded, open, waiting, load, openThread, reply, archive, showArchived, changed, reset }
})
