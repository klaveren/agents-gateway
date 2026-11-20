<script setup lang="ts">
  import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import Icon from './Icon.vue'
  import { api, ApiError, openStream } from '@/lib/api'
  import { isControlKey, keyCodeOf } from '@/lib/keyCodes'
  import { readSse } from '@/lib/sse'
  import '@/styles/monokai.css'

  /**
   * 👁️ O navegador da conversa, ao vivo: os quadros que o gateway tira da aba que o agente está usando (`/sessions/:id/browser`).
   *
   * 📐 A aba renderiza no TAMANHO DA GAVETA (o gateway ajusta a tela dela enquanto alguém olha): o site fica no layout que
   * cabe aqui, e um pixel da imagem é um pixel da aba. 🖱️ Com `interactive`, o clique, a rolagem e o teclado vão para a aba.
   */
  const props = defineProps<{ sessionId: string; interactive?: boolean }>()
  const emit = defineEmits<{ pick: [element: IPickedElement] }>()

  /** O elemento sob a seta (ver `ILiveBrowserElement` no gateway). */
  interface IPickedElement {
    tag: string
    selector: string
    text?: string
    html: string
    url?: string
    rect: { x: number; y: number; width: number; height: number }
  }

  const live = ref<boolean>()
  /** 🗂️ As abas do navegador do agente; clicar mostra outra (o agente segue na dele). */
  const tabs = ref<Array<{ id: string; title: string; url: string }>>([])
  const currentTab = ref<string>()
  const tabLabel = (tab: { title: string; url: string }) => tab.title || (tab.url === 'about:blank' ? 'Nova aba' : tab.url.replace(/^https?:\/\//, ''))
  const frame = ref<{ src: string; url?: string; title?: string; width?: number; height?: number }>()
  const error = ref<string>()
  const screen = ref<HTMLElement>()
  const focused = ref(false)
  let abort: AbortController | undefined
  let retry: ReturnType<typeof setTimeout> | undefined

  const base = () => `/sessions/${encodeURIComponent(props.sessionId)}/browser`

  async function connect(sessionId: string) {
    abort?.abort()
    clearTimeout(retry)
    const controller = new AbortController()
    abort = controller
    error.value = undefined
    try {
      const body = await openStream(`/sessions/${encodeURIComponent(sessionId)}/browser`, { signal: controller.signal })
      for await (const event of readSse(body)) {
        const data = event.data as {
          live?: boolean
          data?: string
          url?: string
          title?: string
          width?: number
          height?: number
          tabs?: Array<{ id: string; title: string; url: string }>
          current?: string
        }
        if (event.event === 'browser.tabs') {
          tabs.value = data.tabs ?? []
          currentTab.value = data.current
        } else if (event.event === 'browser.state') {
          if (!data.live) tabs.value = []
          live.value = !!data.live
          // Navegador novo (ou o mesmo, numa conexão nova): ele ainda não sabe o tamanho da gaveta.
          if (data.live) sendViewport()
        } else if (event.event === 'browser.frame' && data.data) {
          live.value = true
          frame.value = { src: `data:image/jpeg;base64,${data.data}`, url: data.url, title: data.title, width: data.width, height: data.height }
        }
      }
    } catch (failure) {
      if (controller.signal.aborted) return
      error.value = failure instanceof Error ? failure.message : 'A conexão caiu.'
    }
    // O stream fechou (o gateway reiniciou, a credencial foi conferida de novo): tenta de novo em instantes.
    if (!controller.signal.aborted) retry = setTimeout(() => void connect(sessionId), 3000)
  }

  // 📐 O tamanho da gaveta vai para a aba (com uma folga entre um arrasto e outro).
  let sizeTimer: ReturnType<typeof setTimeout> | undefined
  function sendViewport() {
    clearTimeout(sizeTimer)
    sizeTimer = setTimeout(() => {
      const box = screen.value?.getBoundingClientRect()
      if (!box || box.width < 50 || box.height < 50 || !live.value) return
      void api(`${base()}/viewport`, { method: 'POST', body: { width: Math.floor(box.width), height: Math.floor(box.height), scale: window.devicePixelRatio || 1 } }).catch(
        () => undefined,
      )
    }, 200)
  }
  let observer: ResizeObserver | undefined
  onMounted(() => {
    observer = new ResizeObserver(() => sendViewport())
    if (screen.value) observer.observe(screen.value)
  })

  // 🖱️ A entrada vai em fila: a ordem do clique e das teclas é a da pessoa.
  let queue = Promise.resolve()
  function send(event: Record<string, unknown>) {
    if (!props.interactive || !live.value) return
    queue = queue.then(() =>
      api(`${base()}/input`, { method: 'POST', body: event }).then(
        () => undefined,
        () => undefined,
      ),
    )
  }

  /** Do ponto na imagem para o pixel da aba (a imagem pode estar menor que a aba enquanto a gaveta muda de tamanho). */
  function point(event: MouseEvent): { x: number; y: number } | undefined {
    const image = event.currentTarget as HTMLElement
    const box = image.getBoundingClientRect()
    if (!box.width || !box.height) return undefined
    const width = frame.value?.width ?? box.width
    const height = frame.value?.height ?? box.height
    return { x: ((event.clientX - box.left) * width) / box.width, y: ((event.clientY - box.top) * height) / box.height }
  }

  const modifiers = (event: KeyboardEvent | MouseEvent) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

  // 🧭 A barra: voltar, avançar, recarregar e o endereço (Enter navega).
  const address = ref('')
  const editing = ref(false)
  watch(
    () => frame.value?.url,
    (url) => {
      if (!editing.value) address.value = url ?? ''
    },
  )
  /** Sem esquema, https (o gateway confere de novo). */
  const normalize = (raw: string) => (/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)

  // 🙋 Sem navegador aberto, a PESSOA abre o dela (para entrar num site); o agente usa este mesmo depois.
  const opening = ref(false)
  const openError = ref<string>()
  async function openBrowser(url?: string) {
    if (!props.interactive || opening.value) return
    opening.value = true
    openError.value = undefined
    try {
      await api(`${base()}/open`, { method: 'POST', body: url ? { url } : {} })
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : undefined
      openError.value =
        code === 'browser_unavailable'
          ? 'Este servidor não tem um navegador instalado.'
          : code === 'browser_disabled'
            ? 'O navegador está desligado neste servidor.'
            : code === 'url_blocked'
              ? 'Este endereço não abre no navegador.'
              : failure instanceof Error
                ? failure.message
                : 'Não foi possível abrir o navegador.'
    } finally {
      opening.value = false
    }
  }

  function go() {
    const url = address.value.trim()
    editing.value = false
    if (!url) return
    if (live.value) send({ type: 'navigate', url })
    else void openBrowser(normalize(url))
  }

  // 🎯 A seta: passar o mouse destaca o elemento; o clique o manda para a conversa.
  const picking = ref(false)
  const hover = ref<{ left: number; top: number; width: number; height: number; label: string }>()
  let inspectAt = 0
  async function inspect(event: MouseEvent): Promise<IPickedElement | undefined> {
    const at = point(event)
    if (!at) return undefined
    const result = await api<{ element: IPickedElement | null }>(`${base()}/inspect`, { method: 'POST', body: at }).catch(() => undefined)
    return result?.element ?? undefined
  }
  async function hoverPick(event: MouseEvent) {
    const now = Date.now()
    if (now - inspectAt < 120) return
    inspectAt = now
    const image = event.currentTarget as HTMLElement
    const element = await inspect(event)
    if (!element || !picking.value) return void (hover.value = undefined)
    const box = image.getBoundingClientRect()
    const ratio = box.width / (frame.value?.width ?? box.width)
    hover.value = {
      left: element.rect.x * ratio,
      top: element.rect.y * ratio,
      width: element.rect.width * ratio,
      height: element.rect.height * ratio,
      label: element.selector.split(' > ').pop() ?? element.tag,
    }
  }
  async function choose(event: MouseEvent) {
    const element = await inspect(event)
    picking.value = false
    hover.value = undefined
    if (element) emit('pick', element)
  }
  function togglePick() {
    picking.value = !picking.value
    hover.value = undefined
  }

  function onClick(event: MouseEvent) {
    if (picking.value) return void choose(event)
    screen.value?.focus()
    const at = point(event)
    if (at)
      send({
        type: 'click',
        ...at,
        button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
        clickCount: Math.min(3, event.detail || 1),
        modifiers: modifiers(event),
      })
  }

  let lastMove = 0
  function onMove(event: MouseEvent) {
    if (picking.value) return void hoverPick(event)
    const now = Date.now()
    if (now - lastMove < 80) return
    lastMove = now
    const at = point(event)
    if (at) send({ type: 'move', ...at })
  }

  let wheel = { x: 0, y: 0, dx: 0, dy: 0 }
  let wheelTimer: ReturnType<typeof setTimeout> | undefined
  function onWheel(event: WheelEvent) {
    if (!props.interactive || !live.value) return
    event.preventDefault()
    const at = point(event)
    if (!at) return
    wheel = { x: at.x, y: at.y, dx: wheel.dx + event.deltaX, dy: wheel.dy + event.deltaY }
    if (wheelTimer) return
    wheelTimer = setTimeout(() => {
      wheelTimer = undefined
      send({ type: 'wheel', x: wheel.x, y: wheel.y, deltaX: wheel.dx, deltaY: wheel.dy })
      wheel = { x: 0, y: 0, dx: 0, dy: 0 }
    }, 50)
  }

  function onKey(event: KeyboardEvent) {
    if (!props.interactive || !live.value) return
    if (picking.value && event.key === 'Escape') {
      event.preventDefault()
      return togglePick()
    }
    // Colar: o evento `paste` traz o texto.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return
    const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey
    if (!printable && !isControlKey(event.key) && !event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    const keyCode = keyCodeOf(event)
    send({ type: 'key', key: event.key, code: event.code, keyCode, text: printable ? event.key : event.key === 'Enter' ? '\r' : undefined, modifiers: modifiers(event) })
  }
  function onPaste(event: ClipboardEvent) {
    if (!props.interactive || !live.value) return
    const text = event.clipboardData?.getData('text')
    if (!text) return
    event.preventDefault()
    send({ type: 'text', text })
  }

  watch(
    () => props.sessionId,
    (id) => {
      frame.value = undefined
      live.value = undefined
      void connect(id)
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    abort?.abort()
    clearTimeout(retry)
    clearTimeout(sizeTimer)
    observer?.disconnect()
  })
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" data-test="live-browser">
    <div v-if="tabs.length" class="mk-tabs flex h-8 shrink-0" data-test="live-browser-tabs">
      <div class="flex min-w-0 flex-1 overflow-x-auto" role="tablist">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          role="tab"
          :aria-selected="tab.id === currentTab"
          class="mk-editor-tab group flex max-w-52 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 pr-1 pl-3 text-xs"
          :class="{ 'mk-editor-tab-on': tab.id === currentTab }"
          :title="tab.url"
          data-test="live-browser-tab"
          @click="send({ type: 'tab-select', targetId: tab.id })"
          @auxclick.middle.prevent="tabs.length > 1 && send({ type: 'tab-close', targetId: tab.id })"
        >
          <span class="min-w-0 truncate">{{ tabLabel(tab) }}</span>
          <button
            v-if="interactive && tabs.length > 1"
            type="button"
            class="mk-hover grid h-5 w-5 shrink-0 place-items-center rounded opacity-0 group-hover:opacity-100"
            title="Fechar a aba"
            data-test="live-browser-tab-close"
            @click.stop="send({ type: 'tab-close', targetId: tab.id })"
          >
            <Icon name="x" class="h-3 w-3" />
          </button>
        </div>
      </div>
      <button
        v-if="interactive"
        type="button"
        class="mk-muted mk-hover grid h-8 w-8 shrink-0 place-items-center"
        title="Nova aba"
        data-test="live-browser-tab-new"
        @click="send({ type: 'tab-new' })"
      >
        <Icon name="plus" class="h-4 w-4" />
      </button>
    </div>
    <div class="flex items-center gap-1 px-2 py-1.5" data-test="live-browser-bar">
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="live ? 'animate-pulse bg-emerald-400' : 'bg-zinc-600'"
        :title="live ? 'Ao vivo' : 'Navegador fechado'"
        data-test="live-browser-state"
      />
      <button type="button" class="bar-btn" title="Voltar" :disabled="!interactive || !live" data-test="live-browser-back" @click="send({ type: 'back' })">
        <Icon name="back" class="h-4 w-4" />
      </button>
      <button type="button" class="bar-btn" title="Avançar" :disabled="!interactive || !live" data-test="live-browser-forward" @click="send({ type: 'forward' })">
        <Icon name="forward" class="h-4 w-4" />
      </button>
      <button type="button" class="bar-btn" title="Recarregar" :disabled="!interactive || !live" data-test="live-browser-reload" @click="send({ type: 'reload' })">
        <Icon name="refresh" class="h-4 w-4" />
      </button>
      <input
        v-model="address"
        type="text"
        spellcheck="false"
        autocomplete="off"
        class="h-8 min-w-0 flex-1 rounded-full bg-zinc-900 px-3 text-center font-mono text-xs text-zinc-300 outline-none focus:bg-zinc-800 focus:text-left"
        :readonly="!interactive"
        :placeholder="interactive && !live ? 'Digite um endereço para abrir o navegador' : 'endereço'"
        data-test="live-browser-url"
        @focus="((editing = true), ($event.target as HTMLInputElement).select())"
        @blur="((editing = false), (address = frame?.url ?? ''))"
        @keydown.enter.prevent="go"
        @keydown.escape="($event.target as HTMLInputElement).blur()"
      />
      <button
        type="button"
        class="bar-btn"
        :class="{ 'bg-emerald-500/20 text-emerald-300': picking }"
        title="Escolher um elemento da página para a conversa"
        :disabled="!interactive || !live"
        data-test="live-browser-pick"
        @click="togglePick"
      >
        <Icon name="pick" class="h-4 w-4" />
      </button>
    </div>
    <div
      ref="screen"
      :tabindex="interactive ? 0 : undefined"
      class="relative min-h-0 flex-1 overflow-hidden border-t bg-zinc-900/50 outline-none"
      :class="focused && interactive && live ? 'border-emerald-500' : 'border-zinc-800'"
      data-test="live-browser-screen"
      @focus="focused = true"
      @blur="focused = false"
      @keydown="onKey"
      @paste="onPaste"
    >
      <img
        v-if="frame"
        :src="frame.src"
        :alt="frame.title ?? 'Tela do navegador'"
        draggable="false"
        class="block w-full select-none"
        :class="[{ 'opacity-50': live === false }, picking ? 'cursor-crosshair' : interactive && live ? 'cursor-pointer' : '']"
        data-test="live-browser-frame"
        @click="onClick"
        @contextmenu.prevent="onClick"
        @mousemove="onMove"
        @wheel="onWheel"
        @mouseleave="hover = undefined"
      />
      <div
        v-if="picking && hover"
        class="pointer-events-none absolute border-2 border-emerald-400 bg-emerald-400/10"
        :style="{ left: `${hover.left}px`, top: `${hover.top}px`, width: `${hover.width}px`, height: `${hover.height}px` }"
        data-test="live-browser-highlight"
      >
        <span class="absolute -top-5 left-0 rounded bg-emerald-500 px-1 font-mono text-[10px] whitespace-nowrap text-zinc-950">{{ hover.label }}</span>
      </div>
      <span v-if="frame && live === false" class="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-zinc-900/90 px-3 py-1 text-xs text-zinc-400">
        O navegador fechou: esta é a última tela.
      </span>
      <span
        v-if="openError && frame"
        class="absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-red-500/90 px-3 py-1 text-xs text-zinc-950"
        data-test="live-browser-open-error"
      >
        {{ openError }}
      </span>
      <span v-if="picking" class="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500/90 px-3 py-1 text-xs text-zinc-950">
        Clique num elemento · Esc cancela
      </span>
      <div v-else-if="!frame && interactive && !live" class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-test="live-browser-empty">
        <button
          type="button"
          class="rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
          :disabled="opening"
          data-test="live-browser-open"
          @click="openBrowser()"
        >
          Abrir navegador
        </button>
        <p class="max-w-xs text-sm text-zinc-500">Você pode entrar nos sites aqui; o agente usa este mesmo navegador, já logado.</p>
        <p v-if="openError" class="max-w-xs text-xs text-red-400" data-test="live-browser-open-error">{{ openError }}</p>
      </div>
      <p v-else-if="!frame" class="p-6 text-center text-sm text-zinc-500">
        {{ error ?? (live ? 'Esperando a primeira imagem…' : 'O navegador aparece aqui quando o agente abrir uma página.') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
  .bar-btn {
    display: grid;
    height: 2rem;
    width: 2rem;
    flex-shrink: 0;
    place-items: center;
    border-radius: 9999px;
    color: rgb(161 161 170);
  }
  .bar-btn:hover:not(:disabled) {
    background: rgb(39 39 42);
    color: rgb(244 244 245);
  }
  .bar-btn:disabled {
    opacity: 0.4;
  }
</style>
