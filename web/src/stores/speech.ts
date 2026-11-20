import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, apiBlob } from '@/lib/api'
import { inMacApp } from '@/lib/servers'
import { SILENT_AUDIO, speakable, type IVoice } from '@/lib/speech'
import type { IPersonMessage } from './messages'

type TResult = 'ended' | 'blocked' | 'error' | 'stopped'

/** Um áudio na fila: o endereço dele (a mensagem ou a frase de teste). */
interface IItem {
  key: string
  path: string
}

/**
 * 🔊 A VOZ: as preferências da pessoa (`/me/voice`) e a fila que toca as mensagens dos agentes quando chegam. O áudio vem
 * do gateway (`/messages/:fio/:id/speech`); a tela só toca. Nunca marca mensagem como lida.
 * ⚠️ O navegador bloqueia som sem interação: o `play()` recusado liga `blocked` e a tela mostra "Ativar som" (`unlock`).
 */
export const useSpeechStore = defineStore('speech', () => {
  const voice = ref<IVoice>()
  const blocked = ref(false)
  const playing = ref(false)
  /** O último problema ao tocar (o Perfil mostra junto do Testar); some no próximo sucesso. */
  const error = ref<string>()
  const startedAt = Date.now()
  const seen = new Set<string>()
  let queue: IItem[] = []
  let last: IItem | undefined
  let audio: HTMLAudioElement | undefined
  let finish: ((result: TResult) => void) | undefined
  let busy = false
  let generation = 0

  const active = computed(() => playing.value || queue.length > 0)

  async function load(): Promise<void> {
    voice.value = await api<IVoice>('/me/voice')
  }

  /** As preferências, lidas uma vez (a tela do Perfil as relê ao abrir). */
  async function ensure(): Promise<void> {
    if (!voice.value) await load()
  }

  async function save(patch: { enabled?: boolean; voice?: string | null; rate?: number; minLevel?: IVoice['minLevel'] }): Promise<void> {
    voice.value = await api<IVoice>('/me/voice', { method: 'PUT', body: patch })
  }

  /** Chegou mensagem no fio: se a pessoa ligou a voz, fala as novas do agente (no app do Mac, quem fala é o ícone da barra). */
  async function onMessageCreated(conversationId: string): Promise<void> {
    if (inMacApp()) return
    try {
      await ensure()
      const prefs = voice.value
      if (!prefs?.enabled || !prefs.engine.available) return
      const { messages } = await api<{ messages: IPersonMessage[] }>(`/messages/${encodeURIComponent(conversationId)}`)
      const fresh = speakable(messages, { since: startedAt, minLevel: prefs.minLevel, seen })
      for (const message of fresh) {
        seen.add(message.id)
        queue.push({ key: message.id, path: `/messages/${encodeURIComponent(conversationId)}/${encodeURIComponent(message.id)}/speech` })
      }
      if (fresh.length) void pump()
    } catch {
      // Sem voz não é erro da tela: a mensagem continua na caixa.
    }
  }

  /** O motivo da última falha ao tocar (o nome do erro do navegador), para a mensagem do Perfil. */
  let failure = ''

  function element(): HTMLAudioElement {
    return (audio ??= new Audio())
  }

  function play(url: string): Promise<TResult> {
    return new Promise<TResult>((resolve) => {
      const element_ = element()
      finish = resolve
      element_.onended = () => resolve('ended')
      element_.onerror = () => {
        failure = `código ${element_.error?.code ?? '?'}`
        resolve('error')
      }
      element_.src = url
      playing.value = true
      element_.play().catch((error: unknown) => {
        const name = (error as { name?: string } | undefined)?.name
        // ⚖️ AbortError = um carregamento novo interrompeu o anterior (o mudo do clique): não é falha; o fim ou o erro do
        // áudio de verdade resolvem.
        if (name === 'AbortError') return
        if (name !== 'NotAllowedError') failure = name ?? 'erro'
        resolve(name === 'NotAllowedError' ? 'blocked' : 'error')
      })
    })
  }

  async function pump(): Promise<void> {
    if (busy || blocked.value) return
    busy = true
    const mine = generation
    try {
      while (!blocked.value && mine === generation) {
        const item = queue.shift()
        if (!item) break
        let blob: Blob
        try {
          blob = await apiBlob(item.path)
        } catch (failure) {
          error.value = failure instanceof Error ? failure.message : String(failure)
          continue
        }
        if (mine !== generation) break
        const url = URL.createObjectURL(blob)
        let result: TResult
        try {
          result = await play(url)
        } finally {
          URL.revokeObjectURL(url)
        }
        if (result === 'blocked') {
          queue.unshift(item)
          blocked.value = true
        } else if (result === 'error') error.value = `Não consegui tocar o áudio neste navegador (${failure}).`
        else if (result === 'ended') {
          last = item
          error.value = undefined
        }
      }
    } finally {
      busy = false
      if (mine === generation) playing.value = false
    }
  }

  /** Para a leitura e esvazia a fila. */
  function stop(): void {
    generation++
    queue = []
    audio?.pause()
    finish?.('stopped')
    finish = undefined
    playing.value = false
    busy = false
  }

  /** Toca de novo a última mensagem lida. */
  function replayLast(): void {
    if (!last) return
    const item = last
    stop()
    queue.push(item)
    void pump()
  }

  /** A frase de teste do Perfil (com a voz e a velocidade que a pessoa escolheu). */
  function sample(): void {
    stop()
    error.value = undefined
    // ⚠️ O Safari (e o app do Mac) só deixa tocar o elemento que o CLIQUE já tocou: o áudio de teste chega depois, então
    // o mudo toca agora, ainda dentro do gesto, e o mesmo elemento fica liberado para a frase.
    const element_ = element()
    element_.src = SILENT_AUDIO
    void element_.play().catch(() => undefined)
    blocked.value = false
    queue.push({ key: 'sample', path: '/me/voice/sample' })
    void pump()
  }

  /** O clique da pessoa libera o som: toca um áudio mudo no gesto e retoma a fila. */
  async function unlock(): Promise<void> {
    const element_ = element()
    element_.src = SILENT_AUDIO
    try {
      await element_.play()
    } catch {
      // Se nem o mudo toca, o `pump` bloqueia de novo.
    }
    blocked.value = false
    void pump()
  }

  /** Esquece tudo (logout). */
  function reset(): void {
    stop()
    voice.value = undefined
    blocked.value = false
    seen.clear()
    last = undefined
  }

  return { voice, blocked, playing, error, active, load, ensure, save, onMessageCreated, stop, replayLast, sample, unlock, reset }
})
