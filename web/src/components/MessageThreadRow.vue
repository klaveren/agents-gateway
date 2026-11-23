<script setup lang="ts">
  import { computed, onBeforeUnmount, ref, watch } from 'vue'
  import { openRowId } from '@/composables/useOpenRow'
  import { shortTime } from '@/lib/format'
  import type { IPersonThread } from '@/stores/messages'
  import AgentAvatar from './AgentAvatar.vue'
  import Icon from './Icon.vue'

  /**
   * 💬 Uma linha da lista de Mensagens, com o mesmo "deslizar para revelar" da lista de conversas (ConversationRow): uma
   * ação só (Arquivar, ou Voltar à caixa nas arquivadas) atrás da linha, à direita.
   */
  const props = defineProps<{
    thread: IPersonThread
    active: boolean
    archived?: boolean
    /** O nome do agente e o provedor do avatar, já resolvidos pela lista. */
    name: string
    provider: string
  }>()
  const emit = defineEmits<{ archive: [key: string] }>()

  /** A largura da ação revelada. */
  const ACTIONS_WIDTH = 72
  /** Passou disso (em fração da linha), soltar já arquiva — o "deslizar até o fim" do WhatsApp. */
  const FULL_SWIPE = 0.7
  /** Quanto o dedo/mouse anda antes de virar arrasto: abaixo disso, ainda é um clique. */
  const THRESHOLD = 6
  /** Fim do gesto de rolagem horizontal (o trackpad não avisa quando soltou). */
  const WHEEL_SETTLE_MS = 140
  /** Se a linha ainda estiver aqui depois de arquivar (o servidor recusou), ela volta. */
  const RETURN_MS = 600

  const archiveLabel = computed(() => (props.archived ? 'Voltar à caixa' : 'Arquivar'))
  const id = computed(() => props.thread.id)
  const snippet = (text: string) => text.replace(/\s+/g, ' ').slice(0, 140)

  // ── Deslizar para revelar ────────────────────────────────────────────────────────────────────────

  const root = ref<HTMLElement>()
  /** Deslocamento da linha em px: 0 (fechada) até -largura (fora da tela). */
  const offset = ref(0)
  const dragging = ref(false)

  const isOpen = computed(() => offset.value <= -ACTIONS_WIDTH / 2 && !dragging.value)
  const rowWidth = () => root.value?.offsetWidth || 320

  let startX = 0
  let startY = 0
  let startOffset = 0
  let pointerId: number | undefined
  let tracking = false
  /** O arrasto acabou de soltar: o `click` que o navegador dispara em seguida não pode abrir o fio. */
  let suppressClick = false
  let wheelTimer: ReturnType<typeof setTimeout> | undefined
  let returnTimer: ReturnType<typeof setTimeout> | undefined

  const clamp = (value: number) => Math.min(0, Math.max(-rowWidth(), value))

  function setOpen(open: boolean): void {
    offset.value = open ? -ACTIONS_WIDTH : 0
    if (open) openRowId.value = id.value
    else if (openRowId.value === id.value) openRowId.value = undefined
  }

  function archive(): void {
    if (openRowId.value === id.value) openRowId.value = undefined
    emit('archive', id.value)
  }

  /** ⚖️ Solta: passou de 70% da linha arquiva; passou da metade da ação fica aberta; senão volta. */
  function settle(): void {
    const travelled = -offset.value
    if (travelled > rowWidth() * FULL_SWIPE) {
      // Sai da tela deslizando: a linha some quando a lista a tira (e volta, se o servidor recusar).
      offset.value = -rowWidth()
      archive()
      clearTimeout(returnTimer)
      returnTimer = setTimeout(() => (offset.value = 0), RETURN_MS)
    } else setOpen(travelled > ACTIONS_WIDTH / 2)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    tracking = true
    dragging.value = false
    startX = event.clientX
    startY = event.clientY
    startOffset = offset.value
    pointerId = event.pointerId
  }

  function onPointerMove(event: PointerEvent): void {
    if (!tracking) return
    const dx = event.clientX - startX
    if (!dragging.value) {
      if (Math.abs(dx) < THRESHOLD && Math.abs(event.clientY - startY) < THRESHOLD) return
      // Mais vertical que horizontal: é rolagem da lista, não é com a linha.
      if (Math.abs(event.clientY - startY) > Math.abs(dx)) {
        tracking = false
        return
      }
      dragging.value = true
      openRowId.value = id.value
      if (pointerId !== undefined) (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(pointerId)
    }
    offset.value = clamp(startOffset + dx)
  }

  function onPointerUp(): void {
    if (!tracking) return
    tracking = false
    if (!dragging.value) return
    dragging.value = false
    suppressClick = true
    setTimeout(() => (suppressClick = false), 0)
    settle()
  }

  function onPointerCancel(): void {
    if (!dragging.value) {
      tracking = false
      return
    }
    tracking = false
    dragging.value = false
    settle()
  }

  /** Trackpad: rolar com dois dedos para o lado arrasta a linha; quando para de chegar `wheel`, assenta. */
  function onWheel(event: WheelEvent): void {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || event.deltaX === 0) return
    // ⚠️ Sem isso o navegador usa o gesto para voltar de página.
    event.preventDefault()
    dragging.value = true
    openRowId.value = id.value
    offset.value = clamp(offset.value - event.deltaX)
    clearTimeout(wheelTimer)
    wheelTimer = setTimeout(() => {
      dragging.value = false
      suppressClick = false
      settle()
    }, WHEEL_SETTLE_MS)
  }

  /** Clique na linha: aberta, só fecha; logo depois de arrastar, não faz nada; fechada, deixa o link navegar. */
  function onClickCapture(event: MouseEvent): void {
    if (suppressClick || dragging.value) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (offset.value !== 0) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  // Outra linha abriu (ou a lista pediu para fechar): esta volta.
  watch(openRowId, (open) => {
    if (open !== id.value && offset.value !== 0 && !dragging.value) offset.value = 0
  })

  onBeforeUnmount(() => {
    clearTimeout(wheelTimer)
    clearTimeout(returnTimer)
    if (openRowId.value === id.value) openRowId.value = undefined
  })
</script>

<template>
  <div ref="root" class="group relative overflow-x-clip rounded-xl" data-testid="thread-row">
    <!-- Atrás da linha, à direita: só fica ao alcance quando a linha desliza. Com a linha no lugar, some de vez (depois da
         volta dela): coberta, ainda vazava um fio de cor na borda arredondada. -->
    <div
      class="absolute inset-y-0 right-0 flex"
      :class="{ 'invisible transition-[visibility] delay-200 duration-0 motion-reduce:delay-0': offset === 0 }"
      :style="{ width: `${ACTIONS_WIDTH}px` }"
      :aria-hidden="!isOpen"
      data-testid="thread-actions"
    >
      <button
        type="button"
        class="flex w-full flex-col items-center justify-center gap-1 bg-emerald-600 text-xs font-medium text-white hover:bg-emerald-500"
        :tabindex="isOpen ? 0 : -1"
        data-action="archive"
        @click="archive"
      >
        <Icon name="archive" class="h-5 w-5" />
        {{ archiveLabel }}
      </button>
    </div>

    <div
      class="relative touch-pan-y select-none bg-zinc-950"
      :class="dragging ? '' : 'transition-transform duration-200 ease-out motion-reduce:transition-none'"
      :style="{ transform: `translateX(${offset}px)` }"
      data-testid="thread-slide"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @wheel="onWheel"
      @click.capture="onClickCapture"
    >
      <!-- Teclado e mouse: o mesmo que o gesto, num botão que aparece com o foco ou o passar do mouse (no toque, é o gesto). -->
      <button
        type="button"
        class="absolute top-2 right-2 z-10 rounded-full bg-zinc-800 p-1.5 text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-zinc-50 focus:opacity-100 [@media(hover:none)]:hidden"
        :title="archiveLabel"
        :aria-label="archiveLabel"
        data-test="message-thread-archive"
        @pointerdown.stop
        @click.stop="archive"
      >
        <Icon name="archive" class="h-3.5 w-3.5" />
      </button>
      <RouterLink
        :to="`/messages/${thread.id}`"
        class="flex items-start gap-3 rounded-xl px-2 py-2.5 hover:bg-zinc-900"
        :class="active ? 'bg-zinc-900' : ''"
        draggable="false"
        data-test="message-thread"
        @dragstart.prevent
      >
        <AgentAvatar :name="name" :provider="provider" size="sm" />
        <span class="min-w-0 flex-1">
          <span class="flex items-baseline gap-2">
            <span class="truncate text-sm" :class="thread.unread ? 'font-semibold text-zinc-50' : 'text-zinc-200'">{{ thread.title || name }}</span>
            <span v-if="thread.origin" class="shrink-0 rounded bg-sky-500/15 px-1.5 text-[10px] font-medium text-sky-300" :title="thread.origin.url" data-test="thread-origin">
              {{ thread.origin.projectId }} · servidor
            </span>
            <span class="ml-auto shrink-0 text-xs text-zinc-500">{{ shortTime(thread.last.createdAt) }}</span>
          </span>
          <span class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-xs text-zinc-400">
              <template v-if="thread.last.from === 'person'">Você:</template>
              <template v-else>{{ name }}:</template>
              {{ snippet(thread.last.body) }}
            </span>
            <span
              v-if="thread.last.level !== 'info' && thread.last.from === 'agent'"
              class="h-2 w-2 shrink-0 rounded-full"
              :class="thread.last.level === 'urgent' ? 'bg-rose-400' : 'bg-amber-400'"
            />
            <span v-if="thread.pending" class="shrink-0 rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-300" data-test="thread-pending">
              {{ thread.pending }} {{ thread.pending === 1 ? 'pendente' : 'pendentes' }}
            </span>
            <span v-if="thread.unread" class="shrink-0 rounded-full bg-emerald-500 px-1.5 text-[10px] font-semibold text-zinc-950">{{ thread.unread }}</span>
          </span>
        </span>
      </RouterLink>
    </div>
  </div>
</template>
