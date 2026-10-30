<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ColorSchemeType } from 'diff2html/lib/types'
import { Diff2HtmlUI } from 'diff2html/lib/ui/js/diff2html-ui-slim'
import 'diff2html/bundles/css/diff2html.min.css'
import 'highlight.js/styles/github-dark-dimmed.min.css'
import { api } from '@/lib/api'
import { fullTime } from '@/lib/format'
import Icon from './Icon.vue'

/**
 * AS ALTERAÇÕES DA CONVERSA, como nas IDEs: os arquivos que o agente mudou (com o estado e as linhas), os commits e o
 * diff de cada arquivo, lado a lado ou em linhas. Três recortes: nesta conversa, o que não foi commitado, o branch
 * inteiro. Só leitura (ver `GET /sessions/:id/changes`).
 */
type TScope = 'conversation' | 'uncommitted' | 'branch'
interface IFile {
  path: string
  oldPath?: string
  status: 'M' | 'A' | 'D' | 'R' | 'U'
  additions: number
  deletions: number
  binary: boolean
  protected?: boolean
}
interface ICommit {
  sha: string
  subject: string
  author: string
  at: string
}
interface IChanges {
  files: IFile[]
  commits: ICommit[]
  truncated: boolean
}

const props = defineProps<{ sessionId: string; refreshKey: number }>()
const emit = defineEmits<{ close: []; count: [number] }>()

const SCOPES: Array<{ id: TScope; label: string }> = [
  { id: 'conversation', label: 'Nesta conversa' },
  { id: 'uncommitted', label: 'Não commitado' },
  { id: 'branch', label: 'Branch inteiro' },
]
const STATUS: Record<IFile['status'], { label: string; class: string }> = {
  M: { label: 'M', class: 'text-amber-300' },
  A: { label: 'A', class: 'text-emerald-300' },
  D: { label: 'D', class: 'text-rose-300' },
  R: { label: 'R', class: 'text-sky-300' },
  U: { label: 'U', class: 'text-zinc-400' },
}

const read = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

const scope = ref<TScope>('conversation')
const commit = ref<string>()
const changes = ref<IChanges>()
const selected = ref<string>()
const error = ref<string>()
const loading = ref(false)
const layout = ref<'side-by-side' | 'line-by-line'>(read('gw.diff.layout', 'side-by-side') === 'line-by-line' ? 'line-by-line' : 'side-by-side')
const width = ref(Number(read('gw.diff.width', '900')) || 900)
const diffNote = ref<string>()
const target = ref<HTMLElement>()

const base = computed(() => `/sessions/${encodeURIComponent(props.sessionId)}/changes`)
const query = computed(() => ({ scope: scope.value, ...(commit.value ? { commit: commit.value } : {}) }))
const totals = computed(() => (changes.value?.files ?? []).reduce((sum, file) => ({ add: sum.add + file.additions, del: sum.del + file.deletions }), { add: 0, del: 0 }))

/** A lista em pastas, como a árvore das IDEs: a pasta numa linha, os arquivos dela embaixo. */
const groups = computed(() => {
  const byFolder = new Map<string, IFile[]>()
  for (const file of changes.value?.files ?? []) {
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file])
  }
  return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))
})
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

async function load() {
  loading.value = true
  error.value = undefined
  try {
    changes.value = await api<IChanges>(base.value, { query: query.value })
    if (!commit.value && scope.value === 'conversation') emit('count', changes.value.files.length)
    if (!changes.value.files.some((file) => file.path === selected.value)) selected.value = changes.value.files[0]?.path
    await showDiff()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    loading.value = false
  }
}

async function showDiff() {
  diffNote.value = undefined
  await nextTick()
  if (!target.value) return
  target.value.innerHTML = ''
  const path = selected.value
  if (!path) return
  try {
    const result = await api<{ diff: string; truncated: boolean; protected?: boolean; binary?: boolean }>(base.value, { query: { ...query.value, file: path } })
    if (path !== selected.value) return
    if (result.protected) return void (diffNote.value = 'Arquivo protegido (segredo): o conteúdo não é mostrado.')
    if (result.binary) return void (diffNote.value = 'Arquivo binário.')
    if (!result.diff.trim()) return void (diffNote.value = 'Sem diferença de conteúdo (só permissão ou nome).')
    if (result.truncated) diffNote.value = 'Diff grande: mostrando só o começo.'
    const ui = new Diff2HtmlUI(target.value, result.diff, {
      outputFormat: layout.value,
      drawFileList: false,
      matching: 'lines',
      colorScheme: ColorSchemeType.DARK,
      highlight: true,
      fileContentToggle: false,
      synchronisedScroll: true,
    })
    ui.draw()
    ui.highlightCode()
  } catch (failure) {
    diffNote.value = failure instanceof Error ? failure.message : String(failure)
  }
}

function pickScope(next: TScope) {
  scope.value = next
  commit.value = undefined
}
function pickCommit(sha: string | undefined) {
  commit.value = commit.value === sha ? undefined : sha
}
function pickFile(path: string) {
  selected.value = path
  void showDiff()
}
function setLayout(next: 'side-by-side' | 'line-by-line') {
  layout.value = next
  write('gw.diff.layout', next)
  void showDiff()
}

// Arrastar a borda esquerda muda a largura (lembrada no navegador).
let dragging = false
function startDrag(event: PointerEvent) {
  dragging = true
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
}
function onDrag(event: PointerEvent) {
  if (!dragging) return
  width.value = Math.min(Math.max(window.innerWidth - event.clientX, 420), window.innerWidth - 80)
}
function stopDrag() {
  if (!dragging) return
  dragging = false
  write('gw.diff.width', String(Math.round(width.value)))
}
const onKey = (event: KeyboardEvent) => event.key === 'Escape' && emit('close')

onMounted(() => {
  void load()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
watch([scope, commit], () => void load())
// Terminou um turno: o agente pode ter mudado arquivos.
watch(
  () => props.refreshKey,
  () => void load(),
)
</script>

<template>
  <!-- No celular, tela cheia com fundo; no desktop, só o painel recebe clique: a conversa ao lado segue usável. -->
  <div class="fixed inset-0 z-40 bg-black/40 md:pointer-events-none md:bg-transparent" @click.self="emit('close')">
    <aside
      class="pointer-events-auto absolute top-0 right-0 flex h-full w-full flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl md:w-[var(--panel-width)]"
      :style="{ '--panel-width': `min(${width}px, calc(100vw - 360px))` }"
      aria-label="Alterações"
    >
      <div class="absolute top-0 left-0 hidden h-full w-1.5 cursor-col-resize hover:bg-emerald-500/30 md:block" @pointerdown="startDrag" @pointermove="onDrag" @pointerup="stopDrag" />
      <header class="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <h2 class="font-medium">Alterações</h2>
        <span v-if="changes" class="text-xs text-zinc-400">
          {{ changes.files.length }} arquivo(s) · <span class="text-emerald-300">+{{ totals.add }}</span> <span class="text-rose-300">−{{ totals.del }}</span>
        </span>
        <div class="ml-auto flex items-center gap-1">
          <button v-for="item in SCOPES" :key="item.id" class="chip" :class="{ on: scope === item.id }" @click="pickScope(item.id)">{{ item.label }}</button>
          <button class="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800" title="Atualizar" :disabled="loading" @click="load">
            <Icon name="refresh" class="h-4 w-4" :class="{ 'animate-spin': loading }" />
          </button>
          <button class="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800" title="Fechar" @click="emit('close')"><Icon name="x" class="h-4 w-4" /></button>
        </div>
      </header>

      <p v-if="error" class="px-4 py-2 text-sm text-rose-300">{{ error }}</p>
      <div v-else class="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav class="scroll-thin max-h-[40%] shrink-0 overflow-y-auto border-b border-zinc-800 md:max-h-none md:w-72 md:border-r md:border-b-0">
          <section v-if="changes?.commits.length" class="border-b border-zinc-800 px-2 py-2">
            <div class="px-1 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Commits</div>
            <button
              v-for="item in changes.commits"
              :key="item.sha"
              class="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-zinc-900"
              :class="commit === item.sha ? 'bg-emerald-500/10 text-emerald-200' : 'text-zinc-300'"
              :title="`${item.author} · ${fullTime(item.at)}`"
              @click="pickCommit(item.sha)"
            >
              <code class="shrink-0 text-zinc-500">{{ item.sha.slice(0, 7) }}</code>
              <span class="min-w-0 flex-1 truncate">{{ item.subject }}</span>
            </button>
            <button v-if="commit" class="mt-1 px-1.5 text-xs text-zinc-400 hover:text-white" @click="pickCommit(undefined)">← todo o recorte</button>
          </section>
          <p v-if="changes && !changes.files.length" class="px-3 py-3 text-xs text-zinc-500">Nada mudou neste recorte.</p>
          <div v-for="[folder, files] in groups" :key="folder" class="px-2 py-1">
            <div v-if="folder" class="truncate px-1 pt-1 text-[11px] text-zinc-500" :title="folder">{{ folder }}/</div>
            <button
              v-for="file in files"
              :key="file.path"
              class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-zinc-900"
              :class="selected === file.path ? 'bg-zinc-800 text-white' : 'text-zinc-300'"
              :title="file.oldPath ? `${file.oldPath} → ${file.path}` : file.path"
              @click="pickFile(file.path)"
            >
              <span class="w-3 shrink-0 text-center font-mono font-semibold" :class="STATUS[file.status].class">{{ STATUS[file.status].label }}</span>
              <span class="min-w-0 flex-1 truncate" :class="{ 'line-through opacity-70': file.status === 'D' }">{{ nameOf(file.path) }}</span>
              <span v-if="file.protected" class="shrink-0 text-amber-300" title="Segredo: sem conteúdo">🔒</span>
              <span v-else-if="file.binary" class="shrink-0 text-zinc-500">bin</span>
              <span v-else class="shrink-0 tabular-nums"><span class="text-emerald-400">+{{ file.additions }}</span> <span class="text-rose-400">−{{ file.deletions }}</span></span>
            </button>
          </div>
          <p v-if="changes?.truncated" class="px-3 py-2 text-xs text-amber-300">Mostrando os primeiros 300 arquivos.</p>
        </nav>

        <section class="flex min-w-0 flex-1 flex-col">
          <div class="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
            <code class="min-w-0 flex-1 truncate text-zinc-200">{{ selected ?? '—' }}</code>
            <button class="chip" :class="{ on: layout === 'side-by-side' }" @click="setLayout('side-by-side')">Lado a lado</button>
            <button class="chip" :class="{ on: layout === 'line-by-line' }" @click="setLayout('line-by-line')">Em linhas</button>
          </div>
          <p v-if="diffNote" class="px-3 py-2 text-xs text-zinc-400">{{ diffNote }}</p>
          <div ref="target" class="changes-diff scroll-thin min-h-0 flex-1 overflow-auto" />
        </section>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* O diff no tema da tela (o diff2html escuro, com o fundo e as bordas daqui). */
.changes-diff :deep(.d2h-file-wrapper) {
  border: 0;
  border-radius: 0;
  margin: 0;
}
.changes-diff :deep(.d2h-file-header) {
  display: none;
}
.changes-diff :deep(.d2h-dark-color-scheme),
.changes-diff :deep(.d2h-file-wrapper) {
  background-color: #09090b;
}
.changes-diff :deep(.d2h-code-line),
.changes-diff :deep(.d2h-code-side-line) {
  font-size: 12px;
}
/* O tema do destaque pinta um fundo próprio atrás do código: aqui vale o da linha (verde, vermelho, neutro). */
.changes-diff :deep(.hljs) {
  background: transparent;
}
</style>
