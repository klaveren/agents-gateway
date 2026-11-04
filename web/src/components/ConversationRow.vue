<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { openRowId } from '@/composables/useOpenRow'
import { CLASSIFICATION_COLOR, CLASSIFICATION_LABEL, shortTime } from '@/lib/format'
import { usePopover } from '@/lib/popover'
import type { IConversation } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useConversationsStore } from '@/stores/conversations'
import AgentAvatar from './AgentAvatar.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import Icon from './Icon.vue'

const props = defineProps<{ conversation: IConversation; active: boolean; unread: boolean; running?: boolean; showOwner: boolean; archived?: boolean }>()

/** A largura das duas ações reveladas (2 × 72px). */
const ACTIONS_WIDTH = 144
/** Passou disso (em fração da linha), soltar já arquiva — o "deslizar até o fim" do WhatsApp. */
const FULL_SWIPE = 0.7
/** Quanto o dedo/mouse anda antes de virar arrasto: abaixo disso, ainda é um clique. */
const THRESHOLD = 6
/** Fim do gesto de rolagem horizontal (o trackpad não avisa quando soltou). */
const WHEEL_SETTLE_MS = 140

const agents = useAgentsStore()
const conversations = useConversationsStore()
const agentName = computed(() => agents.byId.get(props.conversation.agentId)?.name ?? props.conversation.agentId)
const owner = computed(() => props.conversation.metadata?.owner?.email ?? props.conversation.metadata?.owner?.id)
const archiveLabel = computed(() => (props.archived ? 'Desarquivar' : 'Arquivar'))

/** A última fala: a do agente, se respondeu; senão, a pergunta que ficou sem resposta. */
const preview = computed(() => {
  const last = props.conversation.preview
  if (!last) return 'Sem mensagens ainda'
  return plain(last.text) || `Você: ${plain(last.request)}`
})

/** A prévia é uma linha de texto: a marcação do markdown (cercas, asteriscos) só atrapalha ali. */
function plain(text: string): string {
  return text
    .replace(/```\w*/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Deslizar para revelar ────────────────────────────────────────────────────────────────────────

const root = ref<HTMLElement>()
/** Deslocamento da linha em px: 0 (fechada) até -largura (fora da tela). */
const offset = ref(0)
const dragging = ref(false)
const confirming = ref(false)
const deleting = ref(false)
const deleteError = ref<string>()

const isOpen = computed(() => offset.value <= -ACTIONS_WIDTH / 2 && !dragging.value)
const rowWidth = () => root.value?.offsetWidth || 320

let startX = 0
let startY = 0
let startOffset = 0
let pointerId: number | undefined
let tracking = false
/** O arrasto acabou de soltar: o `click` que o navegador dispara em seguida não pode abrir a conversa. */
let suppressClick = false
let wheelTimer: ReturnType<typeof setTimeout> | undefined

const clamp = (value: number) => Math.min(0, Math.max(-rowWidth(), value))

function setOpen(open: boolean): void {
  offset.value = open ? -ACTIONS_WIDTH : 0
  if (open) openRowId.value = props.conversation.id
  else if (openRowId.value === props.conversation.id) openRowId.value = undefined
}

/** ⚖️ Solta: passou de 70% da linha arquiva; passou da metade das ações fica aberta; senão volta. */
function settle(): void {
  const travelled = -offset.value
  if (travelled > rowWidth() * FULL_SWIPE) {
    // Sai da tela deslizando: a linha some quando a store a tira da lista (e volta, se o servidor recusar).
    offset.value = -rowWidth()
    void archive()
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
    openRowId.value = props.conversation.id
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
  openRowId.value = props.conversation.id
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
watch(openRowId, (id) => {
  if (id !== props.conversation.id && offset.value !== 0 && !dragging.value) offset.value = 0
})

onBeforeUnmount(() => {
  clearTimeout(wheelTimer)
  if (openRowId.value === props.conversation.id) openRowId.value = undefined
})

// ── Ações ────────────────────────────────────────────────────────────────────────────────────────

const { open: menuOpen, root: menuRoot } = usePopover()

/** Otimista: a linha some na hora; se o servidor recusar, a store devolve e a lista mostra o erro. */
async function archive(): Promise<void> {
  menuOpen.value = false
  if (openRowId.value === props.conversation.id) openRowId.value = undefined
  try {
    await conversations.archive(props.conversation.id, !props.archived)
  } catch {
    // A store já desfez e guardou a mensagem.
    offset.value = 0
  }
}

function askDelete(): void {
  menuOpen.value = false
  confirming.value = true
}

function cancelDelete(): void {
  confirming.value = false
  deleteError.value = undefined
  setOpen(false)
}

async function remove(): Promise<void> {
  deleting.value = true
  deleteError.value = undefined
  try {
    await conversations.remove(props.conversation.id)
    confirming.value = false
    if (openRowId.value === props.conversation.id) openRowId.value = undefined
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : String(error)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div ref="root" class="group relative overflow-x-clip rounded-xl" :class="{ 'z-30': menuOpen }" data-testid="conversation-row">
    <!-- Atrás da linha, à direita: só ficam ao alcance quando a linha desliza. -->
    <div class="absolute inset-y-0 right-0 flex" :style="{ width: `${ACTIONS_WIDTH}px` }" :aria-hidden="!isOpen">
      <button
        type="button"
        class="flex w-1/2 flex-col items-center justify-center gap-1 bg-emerald-600 text-xs font-medium text-white hover:bg-emerald-500"
        :tabindex="isOpen ? 0 : -1"
        data-action="archive"
        @click="archive"
      >
        <Icon name="archive" class="h-5 w-5" />
        {{ archiveLabel }}
      </button>
      <button
        type="button"
        class="flex w-1/2 flex-col items-center justify-center gap-1 bg-rose-600 text-xs font-medium text-white hover:bg-rose-500"
        :tabindex="isOpen ? 0 : -1"
        data-action="delete"
        @click="askDelete"
      >
        <Icon name="trash" class="h-5 w-5" />
        Excluir
      </button>
    </div>

    <div
      class="relative touch-pan-y select-none bg-zinc-950"
      :class="dragging ? '' : 'transition-transform duration-200 ease-out motion-reduce:transition-none'"
      :style="{ transform: `translateX(${offset}px)` }"
      data-testid="conversation-slide"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @wheel="onWheel"
      @click.capture="onClickCapture"
    >
      <RouterLink
        :to="`/c/${conversation.id}`"
        class="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors"
        :class="active ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'"
        draggable="false"
        @dragstart.prevent
      >
        <AgentAvatar :name="agentName" :provider="conversation.provider" size="sm" />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="truncate text-sm font-medium" :class="unread ? 'text-white' : 'text-zinc-100'">{{ conversation.title || 'Conversa sem título' }}</span>
            <span class="ml-auto shrink-0 text-[11px]" :class="unread ? 'text-emerald-400' : 'text-zinc-500'">{{ shortTime(conversation.preview?.at ?? conversation.updatedAt) }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="truncate text-xs" :class="unread ? 'text-zinc-200' : 'text-zinc-400'">
              <span class="text-zinc-500">{{ agentName }}<template v-if="showOwner && owner"> · {{ owner }}</template>:</span>
              {{ preview }}
            </span>
            <span
              v-if="conversation.classification"
              class="ml-auto h-2 w-2 shrink-0 rounded-full"
              :class="CLASSIFICATION_COLOR[conversation.classification]"
              :title="CLASSIFICATION_LABEL[conversation.classification]"
            />
            <span v-if="running" class="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400" :class="{ 'ml-0': conversation.classification }" title="Rodando agora" />
            <span v-if="unread" class="ml-auto h-2 w-2 shrink-0 rounded-full bg-emerald-400" :class="{ 'ml-0': conversation.classification || running }" title="Nova atividade" />
          </div>
        </div>
      </RouterLink>

      <!-- Teclado e mouse: o mesmo que o gesto, num menu que aparece com o foco ou o passar do mouse. -->
      <div ref="menuRoot" class="absolute right-1.5 top-1.5">
        <button
          type="button"
          class="grid h-7 w-7 place-items-center rounded-full bg-zinc-900/90 text-zinc-300 opacity-0 hover:bg-zinc-800 focus:opacity-100 group-hover:opacity-100 max-lg:hidden"
          :class="{ '!opacity-100': menuOpen }"
          title="Mais ações"
          aria-label="Mais ações"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          data-action="menu"
          @pointerdown.stop
          @click.stop="menuOpen = !menuOpen"
        >
          <Icon name="more" class="h-4 w-4" />
        </button>
        <div v-if="menuOpen" role="menu" class="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 py-1 text-sm shadow-xl" @pointerdown.stop>
          <button type="button" role="menuitem" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800" data-action="menu-archive" @click="archive">
            <Icon name="archive" class="h-4 w-4 text-emerald-400" /> {{ archiveLabel }}
          </button>
          <button type="button" role="menuitem" class="flex w-full items-center gap-2 px-3 py-2 text-left text-rose-300 hover:bg-zinc-800" data-action="menu-delete" @click="askDelete">
            <Icon name="trash" class="h-4 w-4" /> Excluir
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="confirming"
      title="Excluir esta conversa?"
      :message="deleteError ?? 'Some da lista para todo mundo e não dá para desfazer.'"
      action="Excluir"
      busy-label="Excluindo…"
      :busy="deleting"
      @confirm="remove"
      @cancel="cancelDelete"
    />
  </div>
</template>
