<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
  import { ColorSchemeType } from 'diff2html/lib/types'
  import { Diff2HtmlUI } from 'diff2html/lib/ui/js/diff2html-ui-slim'
  import 'diff2html/bundles/css/diff2html.min.css'
  import 'highlight.js/styles/github-dark-dimmed.min.css'
  import { api } from '@/lib/api'
  import { fullTime } from '@/lib/format'
  import { useDrawerWidth } from '@/composables/useDrawerWidth'
  import Icon from './Icon.vue'
  import '@/styles/monokai.css'

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

  /** `embedded`: dentro da coluna lateral da conversa (a mesma do navegador e do editor), sem gaveta própria. */
  const props = defineProps<{ sessionId: string; refreshKey: number; embedded?: boolean }>()
  const emit = defineEmits<{ close: []; count: [number] }>()

  const SCOPES: Array<{ id: TScope; label: string }> = [
    { id: 'conversation', label: 'Nesta conversa' },
    { id: 'uncommitted', label: 'Não commitado' },
    { id: 'branch', label: 'Branch inteiro' },
  ]
  const STATUS: Record<IFile['status'], { label: string; class: string }> = {
    M: { label: 'M', class: 'mk-modified' },
    A: { label: 'A', class: 'mk-added' },
    D: { label: 'D', class: 'mk-deleted' },
    R: { label: 'R', class: 'mk-added' },
    U: { label: 'U', class: 'mk-added' },
  }

  /** Os ícones de arquivo (Material Icon Theme), como no editor. */
  const iconSet = shallowRef<typeof import('@/lib/fileIcons')>()
  void import('@/lib/fileIcons').then((module) => (iconSet.value = module))

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
  const { width, startDrag, onDrag, stopDrag } = useDrawerWidth('gw.diff.width', 900, 420)
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
  <div :class="embedded ? 'h-full' : 'fixed inset-0 z-40 bg-black/40 md:pointer-events-none md:bg-transparent'" @click.self="embedded || emit('close')">
    <aside
      :class="
        embedded
          ? 'monokai flex h-full w-full flex-col'
          : 'monokai pointer-events-auto absolute top-0 right-0 flex h-full w-full flex-col border-l border-[#3b3a32] shadow-2xl md:w-[var(--panel-width)]'
      "
      :style="embedded ? undefined : { '--panel-width': `min(${width}px, calc(100vw - 360px))` }"
      aria-label="Alterações"
    >
      <div
        v-if="!embedded"
        class="absolute top-0 left-0 hidden h-full w-1.5 cursor-col-resize hover:bg-emerald-500/30 md:block"
        @pointerdown="startDrag"
        @pointermove="onDrag"
        @pointerup="stopDrag"
      />
      <header class="mk-tabs flex min-h-8 flex-wrap items-center gap-2 pl-3 text-xs">
        <h2 v-if="!embedded" class="mk-fg text-[11px] font-medium tracking-wide uppercase">Alterações</h2>
        <span v-if="changes" class="mk-muted">
          {{ changes.files.length }} arquivo(s) ·
          <span class="mk-added">+{{ totals.add }}</span>
          <span class="mk-deleted">−{{ totals.del }}</span>
        </span>
        <div class="ml-auto flex items-center">
          <button v-for="item in SCOPES" :key="item.id" class="mk-editor-tab h-8 px-3" :class="{ 'mk-editor-tab-on': scope === item.id }" @click="pickScope(item.id)">
            {{ item.label }}
          </button>
          <button class="mk-muted mk-hover grid h-8 w-8 place-items-center" title="Atualizar" :disabled="loading" @click="load">
            <Icon name="refresh" class="h-4 w-4" :class="{ 'animate-spin': loading }" />
          </button>
          <button v-if="!embedded" class="mk-muted mk-hover grid h-8 w-8 place-items-center" title="Fechar" @click="emit('close')">
            <Icon name="x" class="h-4 w-4" />
          </button>
        </div>
      </header>

      <p v-if="error" class="mk-orange px-4 py-2 text-sm">{{ error }}</p>
      <div v-else class="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav class="mk-side mk-border max-h-[40%] shrink-0 overflow-y-auto border-b md:max-h-none md:w-72 md:border-r md:border-b-0">
          <section v-if="changes?.commits.length" class="mk-border border-b px-2 py-2">
            <div class="mk-dim px-1 pb-1 text-[10px] font-semibold tracking-wide uppercase">Commits</div>
            <button
              v-for="item in changes.commits"
              :key="item.sha"
              class="mk-hover flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-xs"
              :class="commit === item.sha ? 'mk-selected' : 'mk-muted'"
              :title="`${item.author} · ${fullTime(item.at)}`"
              @click="pickCommit(item.sha)"
            >
              <code class="mk-orange shrink-0">{{ item.sha.slice(0, 7) }}</code>
              <span class="min-w-0 flex-1 truncate">{{ item.subject }}</span>
            </button>
            <button v-if="commit" class="mk-muted mk-hover mt-1 rounded px-1.5 text-xs" @click="pickCommit(undefined)">← todo o recorte</button>
          </section>
          <p v-if="changes && !changes.files.length" class="mk-dim px-3 py-3 text-xs">Nada mudou neste recorte.</p>
          <div v-for="[folder, files] in groups" :key="folder" class="px-2 py-1">
            <div v-if="folder" class="mk-dim truncate px-1 pt-1 text-[11px]" :title="folder">{{ folder }}/</div>
            <button
              v-for="file in files"
              :key="file.path"
              class="mk-hover flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs"
              :class="selected === file.path ? 'mk-selected' : 'mk-fg'"
              :title="file.oldPath ? `${file.oldPath} → ${file.path}` : file.path"
              @click="pickFile(file.path)"
            >
              <img v-if="iconSet" :src="iconSet.fileIcon(file.path)" alt="" class="h-4 w-4 shrink-0" />
              <span class="min-w-0 flex-1 truncate" :class="[STATUS[file.status].class, { 'line-through opacity-70': file.status === 'D' }]">{{ nameOf(file.path) }}</span>
              <span v-if="file.protected" class="shrink-0 text-amber-300" title="Segredo: sem conteúdo">🔒</span>
              <span v-else-if="file.binary" class="mk-dim shrink-0">bin</span>
              <span v-else class="shrink-0 text-[10px] tabular-nums">
                <span class="mk-added">+{{ file.additions }}</span>
                <span class="mk-deleted">−{{ file.deletions }}</span>
              </span>
              <span class="w-3 shrink-0 text-center font-mono text-[10px]" :class="STATUS[file.status].class">{{ STATUS[file.status].label }}</span>
            </button>
          </div>
          <p v-if="changes?.truncated" class="mk-orange px-3 py-2 text-xs">Mostrando os primeiros 300 arquivos.</p>
        </nav>

        <section class="flex min-w-0 flex-1 flex-col">
          <div class="mk-tabs flex h-8 items-center gap-2 pl-3 text-xs">
            <img v-if="iconSet && selected" :src="iconSet.fileIcon(selected)" alt="" class="h-3.5 w-3.5 shrink-0" />
            <code class="mk-fg min-w-0 flex-1 truncate">{{ selected ?? '—' }}</code>
            <button class="mk-editor-tab h-8 px-3" :class="{ 'mk-editor-tab-on': layout === 'side-by-side' }" @click="setLayout('side-by-side')">Lado a lado</button>
            <button class="mk-editor-tab h-8 px-3" :class="{ 'mk-editor-tab-on': layout === 'line-by-line' }" @click="setLayout('line-by-line')">Em linhas</button>
          </div>
          <p v-if="diffNote" class="mk-muted px-3 py-2 text-xs">{{ diffNote }}</p>
          <div ref="target" class="changes-diff min-h-0 flex-1 overflow-auto" />
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
  /* 🎨 O diff no Monokai: fundo do editor, linhas adicionadas em verde e removidas em vermelho, discretas. */
  .changes-diff :deep(.d2h-dark-color-scheme),
  .changes-diff :deep(.d2h-file-wrapper),
  .changes-diff :deep(.d2h-code-line-ctn),
  .changes-diff :deep(.d2h-cntx) {
    background-color: #272822;
    color: #f8f8f2;
  }
  .changes-diff :deep(.d2h-code-linenumber),
  .changes-diff :deep(.d2h-code-side-linenumber) {
    background-color: #272822;
    color: #75715e;
    border-color: #3b3a32;
  }
  .changes-diff :deep(.d2h-ins),
  .changes-diff :deep(.d2h-ins .d2h-code-line-ctn) {
    background-color: rgb(166 226 46 / 0.12);
  }
  .changes-diff :deep(.d2h-del),
  .changes-diff :deep(.d2h-del .d2h-code-line-ctn) {
    background-color: rgb(249 38 114 / 0.14);
  }
  .changes-diff :deep(ins),
  .changes-diff :deep(.d2h-change ins) {
    background-color: rgb(166 226 46 / 0.3);
  }
  .changes-diff :deep(del),
  .changes-diff :deep(.d2h-change del) {
    background-color: rgb(249 38 114 / 0.3);
  }
  .changes-diff :deep(.d2h-info) {
    background-color: #1e1f1c;
    color: #75715e;
    border-color: #3b3a32;
  }
  .changes-diff :deep(.d2h-emptyplaceholder),
  .changes-diff :deep(.d2h-code-side-emptyplaceholder) {
    background-color: #1e1f1c;
    border-color: #3b3a32;
  }
  .changes-diff :deep(.d2h-code-line),
  .changes-diff :deep(.d2h-code-side-line) {
    font-size: 12px;
  }
  /* As cores do código no Monokai (só aqui: o destaque das mensagens da conversa segue o dele). */
  .changes-diff :deep(.hljs-keyword),
  .changes-diff :deep(.hljs-selector-tag),
  .changes-diff :deep(.hljs-tag),
  .changes-diff :deep(.hljs-operator) {
    color: #f92672;
  }
  .changes-diff :deep(.hljs-string),
  .changes-diff :deep(.hljs-regexp),
  .changes-diff :deep(.hljs-attr-value) {
    color: #e6db74;
  }
  .changes-diff :deep(.hljs-number),
  .changes-diff :deep(.hljs-literal),
  .changes-diff :deep(.hljs-built_in) {
    color: #ae81ff;
  }
  .changes-diff :deep(.hljs-title),
  .changes-diff :deep(.hljs-function),
  .changes-diff :deep(.hljs-attr),
  .changes-diff :deep(.hljs-attribute),
  .changes-diff :deep(.hljs-name) {
    color: #a6e22e;
  }
  .changes-diff :deep(.hljs-type),
  .changes-diff :deep(.hljs-class) {
    color: #66d9ef;
  }
  .changes-diff :deep(.hljs-params),
  .changes-diff :deep(.hljs-variable) {
    color: #fd971f;
  }
  .changes-diff :deep(.hljs-comment),
  .changes-diff :deep(.hljs-meta) {
    color: #75715e;
  }
  /* O tema do destaque pinta um fundo próprio atrás do código: aqui vale o da linha (verde, vermelho, neutro). */
  .changes-diff :deep(.hljs) {
    background: transparent;
  }
</style>
