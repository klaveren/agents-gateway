<script setup lang="ts">
  import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
  import type { Terminal } from '@xterm/xterm'
  import type { FitAddon } from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'
  import '@/styles/monokai.css'
  import Icon from './Icon.vue'
  import { api } from '@/lib/api'
  import { watchLive } from '@/lib/liveChannel'

  /**
   * ⌨️ O TERMINAL LOCAL, na coluna da conversa: o seu shell de login, como abrir o Terminal do Mac (ver `Local.Terminal`).
   * Várias abas; o shell continua vivo ao fechar a coluna (e reabre com o que já saiu), até sair ou ficar 30 min sem ninguém.
   */
  const props = defineProps<{ conversation?: string }>()
  const emit = defineEmits<{ close: [] }>()

  interface ISession {
    id: string
    title: string
    cwd: string
    exited?: number
  }
  interface IView {
    session: ISession
    term: Terminal
    fit: FitAddon
    host: HTMLElement
    abort: AbortController
    pending: string
    timer?: ReturnType<typeof setTimeout>
  }

  const available = ref<boolean>()
  const tabs = ref<ISession[]>([])
  const activeId = ref<string>()
  const error = ref<string>()
  const stage = ref<HTMLElement>()
  const views = new Map<string, IView>()
  const xterm = shallowRef<{ Terminal: typeof Terminal; FitAddon: typeof FitAddon }>()

  const MONOKAI = {
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    cursorAccent: '#272822',
    selectionBackground: '#49483e',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  }

  async function loadXterm() {
    if (xterm.value) return xterm.value
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
    xterm.value = { Terminal, FitAddon }
    return xterm.value
  }

  const base = (id: string) => `/terminal/${encodeURIComponent(id)}`

  /** O que é digitado vai junto em lotes curtos (uma colagem não vira mil pedidos), sempre na ordem. */
  let queue = Promise.resolve()
  function send(view: IView, data: string) {
    view.pending += data
    if (view.timer) return
    view.timer = setTimeout(() => {
      const chunk = view.pending
      view.pending = ''
      view.timer = undefined
      queue = queue.then(() =>
        api(`${base(view.session.id)}/input`, { method: 'POST', body: { data: chunk } }).then(
          () => undefined,
          () => undefined,
        ),
      )
    }, 8)
  }

  async function attach(session: ISession) {
    const { Terminal, FitAddon } = await loadXterm()
    await nextTick()
    if (!stage.value || views.has(session.id)) return
    const host = document.createElement('div')
    host.className = 'absolute inset-0 p-2'
    stage.value.appendChild(host)
    const term = new Terminal({
      theme: MONOKAI,
      fontFamily: 'Menlo, Monaco, "SF Mono", ui-monospace, monospace',
      fontSize: 12,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 5000,
      macOptionIsMeta: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    const view: IView = { session, term, fit, host, abort: new AbortController(), pending: '' }
    views.set(session.id, view)
    term.onData((data) => send(view, data))
    term.onResize(({ cols, rows }) => void api(`${base(session.id)}/resize`, { method: 'POST', body: { cols, rows } }).catch(() => undefined))
    show(session.id)
    void stream(view)
  }

  async function stream(view: IView) {
    try {
      // Pelo stream da caixa de entrada (uma conexão a menos por terminal); sem ele, o endpoint do terminal, como antes.
      await watchLive(
        `terminal:${view.session.id}`,
        `${base(view.session.id)}/stream`,
        (type, payload) => {
          const data = payload as { data?: string; code?: number }
          if (type === 'terminal.data' && data.data) view.term.write(data.data)
          else if (type === 'terminal.exit') {
            view.term.write(`\r\n\x1b[90m[processo encerrado: ${data.code ?? 0}]\x1b[0m\r\n`)
            const tab = tabs.value.find((one) => one.id === view.session.id)
            if (tab) tab.exited = data.code ?? 0
          }
        },
        view.abort.signal,
      )
    } catch {
      // A coluna fechou (abort) ou o gateway reiniciou.
    }
  }

  function show(id: string) {
    activeId.value = id
    for (const [key, view] of views) view.host.style.visibility = key === id ? 'visible' : 'hidden'
    const view = views.get(id)
    if (!view) return
    requestAnimationFrame(() => {
      view.fit.fit()
      view.term.focus()
    })
  }

  async function openNew() {
    error.value = undefined
    try {
      const session = await api<ISession>('/terminal', { method: 'POST', body: { cols: 100, rows: 30, ...(props.conversation ? { conversation: props.conversation } : {}) } })
      tabs.value.push(session)
      await attach(session)
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : 'Não deu para abrir o terminal.'
    }
  }

  async function closeTab(id: string) {
    const index = tabs.value.findIndex((one) => one.id === id)
    if (index < 0) return
    const tab = tabs.value[index]
    if (tab.exited === undefined && !window.confirm('Encerrar este terminal?')) return
    await api(`${base(id)}/close`, { method: 'POST', body: {} }).catch(() => undefined)
    const view = views.get(id)
    view?.abort.abort()
    view?.term.dispose()
    view?.host.remove()
    views.delete(id)
    tabs.value.splice(index, 1)
    const next = tabs.value[Math.min(index, tabs.value.length - 1)]
    if (next) show(next.id)
    else activeId.value = undefined
  }

  let observer: ResizeObserver | undefined
  onMounted(async () => {
    const status = await api<{ available: boolean; sessions: ISession[] }>('/terminal').catch(() => ({ available: false, sessions: [] as ISession[] }))
    available.value = status.available
    if (!status.available) return
    observer = new ResizeObserver(() => {
      const view = activeId.value ? views.get(activeId.value) : undefined
      view?.fit.fit()
    })
    if (stage.value) observer.observe(stage.value)
    // Os que já estavam abertos voltam (com o que já saiu); sem nenhum, abre um.
    tabs.value = status.sessions
    for (const session of status.sessions) await attach(session)
    if (!status.sessions.length) await openNew()
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    // Fechar a coluna não mata o shell: só para de olhar (ele volta ao reabrir).
    for (const view of views.values()) {
      view.abort.abort()
      view.term.dispose()
    }
    views.clear()
  })
</script>

<template>
  <div class="monokai flex h-full min-h-0 flex-col" data-test="local-terminal">
    <div class="mk-tabs flex h-8 shrink-0">
      <div class="flex min-w-0 flex-1 overflow-x-auto" role="tablist">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          role="tab"
          :aria-selected="tab.id === activeId"
          class="mk-editor-tab group flex shrink-0 cursor-pointer items-center gap-1.5 pr-1 pl-3 text-xs"
          :class="{ 'mk-editor-tab-on': tab.id === activeId }"
          :title="tab.cwd"
          data-test="terminal-tab"
          @click="show(tab.id)"
          @auxclick.middle.prevent="closeTab(tab.id)"
        >
          <span class="font-mono">{{ tab.title }}</span>
          <span class="mk-dim max-w-32 truncate text-[10px]">{{ tab.cwd.split('/').pop() }}</span>
          <span v-if="tab.exited !== undefined" class="mk-dim text-[10px]">(encerrado)</span>
          <button type="button" class="mk-hover grid h-5 w-5 place-items-center rounded" title="Encerrar" data-test="terminal-tab-close" @click.stop="closeTab(tab.id)">
            <Icon name="x" class="h-3 w-3" />
          </button>
        </div>
      </div>
      <button v-if="available" type="button" class="mk-muted mk-hover grid h-8 w-8 shrink-0 place-items-center" title="Novo terminal" data-test="terminal-new" @click="openNew">
        <Icon name="plus" class="h-4 w-4" />
      </button>
    </div>
    <div v-if="error" class="mk-notice mk-orange px-3 py-1 text-xs">{{ error }}</div>
    <div ref="stage" class="relative min-h-0 flex-1">
      <p v-if="available === false" class="mk-dim p-6 text-center text-sm">
        O terminal é o do seu computador: só abre no app do Mac, com a tela no mesmo computador do gateway, e para o administrador.
      </p>
    </div>
  </div>
</template>
