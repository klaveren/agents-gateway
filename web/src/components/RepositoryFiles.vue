<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
  import type { editor as MonacoEditor } from 'monaco-editor'
  import Icon from './Icon.vue'
  import { api, ApiError } from '@/lib/api'
  import '@/styles/monokai.css'

  /**
   * 📁 Os arquivos do repositório da conversa, no Monaco (o editor do VS Code). A árvore vem do `.gitignore` (sem segredo);
   * salvar (⌘S) só com o agente parado, e recusa se o arquivo mudou desde que foi aberto.
   */
  const props = defineProps<{ sessionId: string; running?: boolean; readOnly?: boolean }>()
  const emit = defineEmits<{ close: [] }>()

  interface IFile {
    path: string
    content?: string
    binary?: boolean
    size: number
    hash: string
  }
  type TMonaco = typeof import('monaco-editor')

  type TStatus = 'M' | 'A' | 'U' | 'R' | 'D'
  const files = ref<string[]>([])
  /** O que não foi commitado (como o VS Code: M modificado, U novo, A adicionado, R renomeado). */
  const status = ref<Record<string, TStatus>>({})
  /** Os ícones do Material Icon Theme: carregam junto com a coluna. */
  const iconSet = shallowRef<typeof import('@/lib/fileIcons')>()
  void import('@/lib/fileIcons').then((module) => (iconSet.value = module))
  const truncated = ref(false)
  const loadError = ref<string>()
  const filter = ref('')
  const expanded = ref(new Set<string>())
  /**
   * 🗂️ AS ABAS do editor, como no VS Code: cada arquivo (ou diff) aberto é uma. Os modelos do Monaco ficam FORA da
   * reatividade (`buffers`): o Vue não pode embrulhar objeto do editor.
   */
  interface ITab {
    key: string
    kind: 'file' | 'diff'
    path: string
    staged?: boolean
    file?: IFile
    dirty: boolean
  }
  interface IBuffer {
    model?: MonacoEditor.ITextModel
    original?: MonacoEditor.ITextModel
    modified?: MonacoEditor.ITextModel
    viewState?: MonacoEditor.ICodeEditorViewState | null
  }
  const tabs = ref<ITab[]>([])
  const activeKey = ref<string>()
  const buffers = new Map<string, IBuffer>()
  const active = computed(() => tabs.value.find((one) => one.key === activeKey.value))
  const opened = computed(() => (active.value?.kind === 'file' ? active.value.file : undefined))
  const dirty = computed(() => !!active.value?.dirty)
  const diffing = computed(() => (active.value?.kind === 'diff' ? { path: active.value.path, staged: !!active.value.staged } : undefined))
  const view = computed(() => active.value?.kind ?? 'file')
  const saving = ref(false)
  const notice = ref<{ tone: 'error' | 'ok'; text: string }>()
  const conflict = ref<IFile>()
  const host = ref<HTMLElement>()
  const monaco = shallowRef<TMonaco>()

  // 📐 A lateral (árvore / alterações): largura arrastável e o botão de esconder, lembrados no navegador.
  const remembered = (key: string, fallback: string) => {
    try {
      return localStorage.getItem(key) ?? fallback
    } catch {
      return fallback
    }
  }
  const remember = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      // sem armazenamento: vale só nesta aba
    }
  }
  const sideOpen = ref(remembered('gw.files.side', '1') === '1')
  const sideWidth = ref(Number(remembered('gw.files.sideWidth', '240')) || 240)
  watch(sideOpen, (open) => remember('gw.files.side', open ? '1' : '0'))
  let dragFrom: { x: number; width: number } | undefined
  function startSideDrag(event: PointerEvent) {
    dragFrom = { x: event.clientX, width: sideWidth.value }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  function onSideDrag(event: PointerEvent) {
    if (!dragFrom) return
    sideWidth.value = Math.min(600, Math.max(160, dragFrom.width + event.clientX - dragFrom.x))
  }
  function stopSideDrag() {
    if (!dragFrom) return
    dragFrom = undefined
    remember('gw.files.sideWidth', String(Math.round(sideWidth.value)))
  }

  // 🌿 O controle de versão (a aba Alterações e a barra de baixo).
  interface IScmEntry {
    path: string
    status: TStatus
  }
  interface IScm {
    branch?: string
    upstream?: string
    ahead: number
    behind: number
    staged: IScmEntry[]
    changes: IScmEntry[]
  }
  const tab = ref<'files' | 'scm' | 'settings'>('files')

  // ⚙️ As configurações do editor, por pessoa (no navegador): valem na hora, no editor e no diff.
  interface IEditorSettings {
    fontSize: number
    wordWrap: boolean
    minimap: boolean
    lineNumbers: boolean
    whitespace: boolean
    sideBySide: boolean
    theme: 'monokai' | 'vs-dark'
  }
  const DEFAULT_SETTINGS: IEditorSettings = { fontSize: 12, wordWrap: false, minimap: false, lineNumbers: true, whitespace: false, sideBySide: true, theme: 'monokai' }
  const storedSettings = (): Partial<IEditorSettings> => {
    try {
      return JSON.parse(remembered('gw.files.settings', '{}')) as Partial<IEditorSettings>
    } catch {
      return {}
    }
  }
  const settings = ref<IEditorSettings>({ ...DEFAULT_SETTINGS, ...storedSettings() })
  const editorOptions = () => ({
    fontSize: settings.value.fontSize,
    wordWrap: settings.value.wordWrap ? ('on' as const) : ('off' as const),
    minimap: { enabled: settings.value.minimap },
    lineNumbers: settings.value.lineNumbers ? ('on' as const) : ('off' as const),
    renderWhitespace: settings.value.whitespace ? ('all' as const) : ('none' as const),
  })
  watch(
    settings,
    (value) => {
      remember('gw.files.settings', JSON.stringify(value))
      monaco.value?.editor.setTheme(value.theme)
      editor?.updateOptions(editorOptions())
      diffEditor?.updateOptions({ ...editorOptions(), renderSideBySide: value.sideBySide })
    },
    { deep: true },
  )
  function resetSettings() {
    settings.value = { ...DEFAULT_SETTINGS }
  }
  const scm = ref<IScm>()
  const message = ref('')
  const scmBusy = ref(false)
  const scmBase = () => `/sessions/${encodeURIComponent(props.sessionId)}/scm`
  async function loadScm() {
    scm.value = await api<IScm>(scmBase()).catch(() => scm.value)
  }
  async function scmRun(action: 'stage' | 'unstage', paths: string[]) {
    if (props.running) return void (notice.value = { tone: 'error', text: 'O agente está trabalhando. Espere ele terminar.' })
    scmBusy.value = true
    try {
      scm.value = await api<IScm>(`${scmBase()}/${action}`, { method: 'POST', body: { paths } })
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu.' }
    } finally {
      scmBusy.value = false
    }
  }
  async function commit() {
    if (!message.value.trim() || props.running || scmBusy.value) return
    scmBusy.value = true
    notice.value = undefined
    try {
      const result = await api<{ commit: string; state: IScm }>(`${scmBase()}/commit`, { method: 'POST', body: { message: message.value } })
      scm.value = result.state
      message.value = ''
      notice.value = { tone: 'ok', text: `Commit ${result.commit.slice(0, 7)} feito.` }
      void loadTree()
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para commitar.' }
    } finally {
      scmBusy.value = false
    }
  }
  const nameOf = (path: string) => path.split('/').pop() ?? path
  const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')

  // 📊 A barra de status do arquivo aberto: cursor, seleção, linguagem, indentação, fim de linha e o blame da linha.
  const cursor = ref<{ line: number; column: number; selected: number; language: string; indent: string; eol: string }>()
  const blame = ref<{ author?: string; time?: number; summary?: string; uncommitted?: boolean }>()
  let blameTimer: ReturnType<typeof setTimeout> | undefined
  let blameLine = 0
  function readCursor() {
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    if (!model || !selection) return void (cursor.value = undefined)
    const options = model.getOptions()
    cursor.value = {
      line: selection.positionLineNumber,
      column: selection.positionColumn,
      selected: model.getValueInRange(selection).length,
      language: model.getLanguageId(),
      indent: options.insertSpaces ? `Espaços: ${options.tabSize}` : `Tab: ${options.tabSize}`,
      eol: model.getEOL() === '\n' ? 'LF' : 'CRLF',
    }
    if (selection.positionLineNumber !== blameLine) {
      blameLine = selection.positionLineNumber
      clearTimeout(blameTimer)
      blameTimer = setTimeout(() => void loadBlame(), 400)
    }
  }
  async function loadBlame() {
    const path = opened.value?.path
    if (!path || !blameLine) return void (blame.value = undefined)
    const line = blameLine
    const result = await api<{ blame: typeof blame.value | null }>(`${scmBase()}/blame`, { query: { path, line: String(line) } }).catch(() => undefined)
    if (opened.value?.path === path && blameLine === line) blame.value = result?.blame ?? undefined
  }
  const ago = (seconds: number) => {
    const diff = seconds - Date.now() / 1000
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ['year', 31_536_000],
      ['month', 2_592_000],
      ['day', 86_400],
      ['hour', 3600],
      ['minute', 60],
    ]
    const format = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
    for (const [unit, size] of units) if (Math.abs(diff) >= size) return format.format(Math.round(diff / size), unit)
    return 'agora'
  }

  // O diff lado a lado (Monaco), numa aba como os arquivos.
  const diffHost = ref<HTMLElement>()
  let diffEditor: MonacoEditor.IStandaloneDiffEditor | undefined
  async function openDiff(path: string, staged: boolean) {
    notice.value = undefined
    const key = `diff:${staged ? 'staged' : 'work'}:${path}`
    try {
      const diff = await api<{ original: string; modified: string }>(`${scmBase()}/diff`, { query: { path, staged: String(staged) } })
      const loaded = monaco.value ?? (await import('@/lib/monaco')).monaco
      monaco.value = loaded
      const language = loaded.languages.getLanguages().find((one) => one.extensions?.some((extension) => path.toLowerCase().endsWith(extension)))?.id
      // Reabrir relê: o arquivo pode ter mudado desde a última vez.
      const old = buffers.get(key)
      if (activeKey.value === key) diffEditor?.setModel(null)
      old?.original?.dispose()
      old?.modified?.dispose()
      buffers.set(key, { original: loaded.editor.createModel(diff.original, language), modified: loaded.editor.createModel(diff.modified, language) })
      if (!tabs.value.some((one) => one.key === key)) tabs.value.push({ key, kind: 'diff', path, staged, dirty: false })
      await activate(key, true)
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para abrir o diff.' }
    }
  }

  /** Mostra a aba: guarda onde o cursor estava na anterior e põe o modelo desta no editor (ou no diff). */
  async function activate(key: string | undefined, force = false) {
    if (key === activeKey.value && !force) return
    const previous = active.value
    if (previous?.kind === 'file' && editor) {
      const buffer = buffers.get(previous.key)
      if (buffer) buffer.viewState = editor.saveViewState()
    }
    activeKey.value = key
    blame.value = undefined
    blameLine = 0
    conflict.value = undefined
    const tab = active.value
    if (!tab) return
    await nextTick()
    const buffer = buffers.get(tab.key)
    if (tab.kind === 'file') {
      if (tab.file?.binary || !buffer?.model) return
      await ensureEditor()
      if (!editor) return
      editor.setModel(buffer.model)
      if (buffer.viewState) editor.restoreViewState(buffer.viewState)
      editor.focus()
      return
    }
    const loaded = monaco.value
    if (!loaded || !diffHost.value || !buffer?.original || !buffer.modified) return
    diffEditor ??= loaded.editor.createDiffEditor(diffHost.value, {
      ...editorOptions(),
      theme: settings.value.theme,
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: settings.value.sideBySide,
      // Estreito demais para lado a lado: uma coluna só (o Monaco decide pela largura).
      useInlineViewWhenSpaceIsLimited: true,
    })
    diffEditor.setModel({ original: buffer.original, modified: buffer.modified })
  }

  /** Fecha a aba (perguntando se tem alteração não salva) e mostra a vizinha. */
  async function closeTab(key: string) {
    const index = tabs.value.findIndex((one) => one.key === key)
    const tab = tabs.value[index]
    if (!tab) return
    if (tab.dirty && !window.confirm(`Descartar as alterações não salvas de ${nameOf(tab.path)}?`)) return
    if (activeKey.value === key) {
      if (tab.kind === 'file') editor?.setModel(null)
      else diffEditor?.setModel(null)
    }
    const buffer = buffers.get(key)
    buffer?.model?.dispose()
    buffer?.original?.dispose()
    buffer?.modified?.dispose()
    buffers.delete(key)
    tabs.value.splice(index, 1)
    if (activeKey.value === key) {
      activeKey.value = undefined
      const next = tabs.value[Math.min(index, tabs.value.length - 1)]
      await activate(next?.key)
    }
  }
  function closeAll() {
    editor?.setModel(null)
    diffEditor?.setModel(null)
    for (const buffer of buffers.values()) {
      buffer.model?.dispose()
      buffer.original?.dispose()
      buffer.modified?.dispose()
    }
    buffers.clear()
    tabs.value = []
    activeKey.value = undefined
  }
  let editor: MonacoEditor.IStandaloneCodeEditor | undefined

  const mobile = window.matchMedia?.('(max-width: 767px)').matches ?? false
  const editable = computed(() => !props.readOnly && !mobile)
  const base = () => `/sessions/${encodeURIComponent(props.sessionId)}/files`

  async function loadTree() {
    loadError.value = undefined
    void loadScm()
    try {
      const result = await api<{ files: string[]; truncated: boolean; status?: Record<string, TStatus> }>(base())
      files.value = result.files
      truncated.value = result.truncated
      status.value = result.status ?? {}
    } catch (failure) {
      loadError.value = failure instanceof Error ? failure.message : 'Não deu para ler os arquivos.'
    }
  }

  /** A árvore visível: as pastas abertas mostram o que têm dentro; com filtro, a lista plana do que casa. */
  interface IRow {
    path: string
    name: string
    depth: number
    folder: boolean
  }
  /** As pastas com algo não commitado dentro (o ponto ao lado do nome). */
  const changedFolders = computed(() => {
    const folders = new Set<string>()
    for (const path of Object.keys(status.value)) {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join('/'))
    }
    return folders
  })
  const STATUS_CLASS: Record<TStatus, string> = { M: 'mk-modified', A: 'mk-added', U: 'mk-added', R: 'mk-added', D: 'mk-deleted' }
  function iconOf(row: IRow): string | undefined {
    const set = iconSet.value
    if (!set) return undefined
    return row.folder ? set.folderIcon(row.path, expanded.value.has(row.path)) : set.fileIcon(row.path)
  }

  const rows = computed<IRow[]>(() => {
    const term = filter.value.trim().toLowerCase()
    if (term)
      return files.value
        .filter((path) => path.toLowerCase().includes(term))
        .slice(0, 500)
        .map((path) => ({ path, name: path, depth: 0, folder: false }))
    const out: IRow[] = []
    const seen = new Set<string>()
    for (const path of files.value) {
      const parts = path.split('/')
      let visible = true
      for (let index = 0; index < parts.length; index += 1) {
        const sub = parts.slice(0, index + 1).join('/')
        const folder = index < parts.length - 1
        if (!visible) break
        if (!seen.has(sub)) {
          seen.add(sub)
          out.push({ path: sub, name: parts[index], depth: index, folder })
        }
        if (folder && !expanded.value.has(sub)) visible = false
      }
    }
    return out
  })

  function toggle(path: string) {
    const next = new Set(expanded.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expanded.value = next
  }

  async function ensureEditor() {
    if (editor || !host.value) return
    const loaded = (await import('@/lib/monaco')).monaco
    monaco.value = loaded
    editor = loaded.editor.create(host.value, {
      ...editorOptions(),
      theme: settings.value.theme,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      readOnly: !editable.value,
    })
    editor.onDidChangeModelContent(() => {
      const tab = active.value
      if (tab?.kind === 'file' && tab.file) tab.dirty = editor?.getValue() !== tab.file.content
    })
    editor.addCommand(loaded.KeyMod.CtrlCmd | loaded.KeyCode.KeyS, () => void save())
    editor.onDidChangeCursorSelection(() => readCursor())
    editor.onDidChangeModel(() => readCursor())
  }

  async function open(path: string) {
    notice.value = undefined
    const key = `file:${path}`
    if (tabs.value.some((one) => one.key === key)) return void (await activate(key))
    try {
      const file = await api<IFile>(base(), { query: { path } })
      if (!file.binary) {
        await ensureEditor()
        const loaded = monaco.value
        if (!loaded) return
        const uri = loaded.Uri.file(`/${props.sessionId}/${path}`)
        loaded.editor.getModel(uri)?.dispose()
        buffers.set(key, { model: loaded.editor.createModel(file.content ?? '', undefined, uri) })
      }
      if (!tabs.value.some((one) => one.key === key)) tabs.value.push({ key, kind: 'file', path, file, dirty: false })
      await activate(key)
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para abrir.' }
    }
  }

  async function save(force = false) {
    const tab = active.value
    if (!editor || tab?.kind !== 'file' || !tab.file || !editable.value || saving.value) return
    if (props.running) return void (notice.value = { tone: 'error', text: 'O agente está trabalhando. Salve quando ele terminar.' })
    saving.value = true
    notice.value = undefined
    const content = editor.getValue()
    try {
      const baseHash = force && conflict.value ? conflict.value.hash : tab.file.hash
      const saved = await api<IFile>(base(), { method: 'PUT', body: { path: tab.path, content, baseHash } })
      tab.file = { ...saved, content }
      tab.dirty = false
      conflict.value = undefined
      notice.value = { tone: 'ok', text: 'Salvo.' }
      void loadTree()
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'revision_conflict') {
        conflict.value = (failure.details as { current?: IFile } | undefined)?.current
        notice.value = { tone: 'error', text: 'O arquivo mudou desde que você abriu (o agente mexeu).' }
      } else notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para salvar.' }
    } finally {
      saving.value = false
    }
  }

  /** Conflito: fica com a versão nova (perde a sua edição). */
  function takeTheirs() {
    const current = conflict.value
    const tab = active.value
    if (!current || !editor || tab?.kind !== 'file') return
    tab.file = current
    editor.setValue(current.content ?? '')
    tab.dirty = false
    conflict.value = undefined
    notice.value = undefined
  }

  watch(
    () => props.sessionId,
    () => {
      closeAll()
      void loadTree()
    },
    { immediate: true },
  )
  // O agente terminou um turno: a árvore pode ter mudado.
  watch(
    () => props.running,
    (running, before) => {
      if (before && !running) void loadTree()
    },
  )
  onBeforeUnmount(() => {
    clearTimeout(blameTimer)
    closeAll()
    editor?.dispose()
    diffEditor?.dispose()
  })
</script>

<template>
  <div class="monokai flex h-full min-h-0 flex-col" data-test="repository-files">
    <div class="flex min-h-0 flex-1">
      <nav
        v-show="sideOpen"
        class="mk-side mk-border relative flex w-[var(--side-w)] shrink-0 flex-col border-r max-md:w-full"
        :class="{ 'max-md:hidden': opened || diffing }"
        :style="{ '--side-w': `${sideWidth}px` }"
        aria-label="Arquivos do repositório"
      >
        <div
          class="absolute top-0 -right-1 z-10 hidden h-full w-2 cursor-col-resize hover:bg-[#75715e]/40 md:block"
          data-test="files-side-resize"
          @pointerdown="startSideDrag"
          @pointermove="onSideDrag"
          @pointerup="stopSideDrag"
        />
        <div class="mk-border flex border-b text-[11px] font-medium tracking-wide uppercase" role="tablist">
          <button type="button" role="tab" class="mk-tab flex-1 py-2" :class="{ 'mk-tab-on': tab === 'files' }" data-test="files-tab-files" @click="tab = 'files'">Arquivos</button>
          <button type="button" role="tab" class="mk-tab flex-1 py-2" :class="{ 'mk-tab-on': tab === 'scm' }" data-test="files-tab-scm" @click="tab = 'scm'">
            Alterações
            <span v-if="scm && scm.staged.length + scm.changes.length" class="mk-count ml-1 rounded-full px-1.5">{{ scm.staged.length + scm.changes.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            class="mk-tab w-9 shrink-0 py-2"
            :class="{ 'mk-tab-on': tab === 'settings' }"
            title="Configurações do editor"
            data-test="files-tab-settings"
            @click="tab = 'settings'"
          >
            <Icon name="settings" class="mx-auto h-3.5 w-3.5" />
          </button>
        </div>
        <template v-if="tab === 'files'">
          <div class="flex items-center gap-1 p-2">
            <input v-model="filter" type="search" placeholder="Buscar arquivo" class="mk-input h-8 min-w-0 flex-1 rounded-md px-2 text-xs outline-none" data-test="files-filter" />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto pb-2 text-xs">
            <p v-if="loadError" class="mk-orange px-3">{{ loadError }}</p>
            <button
              v-for="row in rows"
              :key="row.path"
              type="button"
              class="mk-hover flex w-full items-center gap-1 truncate py-1 pr-2 text-left"
              :class="[
                opened?.path === row.path ? 'mk-selected' : row.folder ? 'mk-fg' : 'mk-muted',
                !row.folder && status[row.path] ? STATUS_CLASS[status[row.path]] : '',
                row.folder && changedFolders.has(row.path) ? 'mk-modified' : '',
              ]"
              :style="{ paddingLeft: `${8 + row.depth * 12}px` }"
              :title="row.path"
              data-test="files-row"
              @click="row.folder ? toggle(row.path) : open(row.path)"
            >
              <span class="mk-dim w-3 shrink-0">{{ row.folder ? (expanded.has(row.path) ? '▾' : '▸') : '' }}</span>
              <img v-if="iconOf(row)" :src="iconOf(row)" alt="" class="h-4 w-4 shrink-0" loading="lazy" />
              <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
              <span v-if="!row.folder && status[row.path]" class="shrink-0 font-mono text-[10px]" data-test="files-status">{{ status[row.path] }}</span>
              <span v-else-if="row.folder && changedFolders.has(row.path)" class="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
            </button>
            <p v-if="truncated" class="mk-dim px-3 pt-2">Lista cortada em 20 mil arquivos: use a busca.</p>
          </div>
        </template>
        <div v-else-if="tab === 'settings'" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs" data-test="files-settings">
          <label class="flex flex-col gap-1">
            <span class="mk-muted">Tamanho da fonte</span>
            <div class="flex items-center gap-2">
              <input v-model.number="settings.fontSize" type="range" min="10" max="20" step="1" class="min-w-0 flex-1 accent-[#a6e22e]" data-test="settings-font" />
              <span class="mk-fg w-8 text-right font-mono">{{ settings.fontSize }}px</span>
            </div>
          </label>
          <label class="flex flex-col gap-1">
            <span class="mk-muted">Tema</span>
            <select v-model="settings.theme" class="mk-input h-8 rounded-md px-2 outline-none" data-test="settings-theme">
              <option value="monokai">Monokai</option>
              <option value="vs-dark">Escuro (VS Code)</option>
            </select>
          </label>
          <label
            v-for="option in [
              { key: 'wordWrap', label: 'Quebrar linhas longas' },
              { key: 'lineNumbers', label: 'Números de linha' },
              { key: 'minimap', label: 'Minimapa' },
              { key: 'whitespace', label: 'Mostrar espaços e tabs' },
              { key: 'sideBySide', label: 'Diff lado a lado' },
            ] as const"
            :key="option.key"
            class="flex cursor-pointer items-center gap-2"
          >
            <input v-model="settings[option.key]" type="checkbox" class="accent-[#a6e22e]" :data-test="`settings-${option.key}`" />
            <span class="mk-fg">{{ option.label }}</span>
          </label>
          <button type="button" class="mk-hover mk-muted mt-1 self-start rounded px-2 py-1" data-test="settings-reset" @click="resetSettings">Voltar ao padrão</button>
          <p class="mk-dim">Ficam guardadas neste navegador.</p>
        </div>
        <div v-else class="flex min-h-0 flex-1 flex-col text-xs" data-test="files-scm">
          <div class="flex flex-col gap-2 p-2">
            <textarea
              v-model="message"
              rows="2"
              placeholder="Mensagem (⌘Enter para commitar)"
              class="mk-input resize-y rounded-md px-2 py-1.5 text-xs outline-none"
              :disabled="readOnly"
              data-test="scm-message"
              @keydown.meta.enter.prevent="commit"
              @keydown.ctrl.enter.prevent="commit"
            />
            <button
              type="button"
              class="mk-commit h-8 rounded-md text-xs font-medium"
              :disabled="readOnly || running || scmBusy || !message.trim() || !scm || !(scm.staged.length + scm.changes.length)"
              :title="running ? 'Commite quando o agente terminar' : scm && !scm.staged.length ? 'Sem nada preparado, commita todas as alterações' : 'Commitar o preparado'"
              data-test="scm-commit"
              @click="commit"
            >
              ✓ Commit{{ scm && !scm.staged.length && scm.changes.length ? ' (tudo)' : '' }}
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto pb-2">
            <template
              v-for="group in [
                { key: 'staged', title: 'Preparadas', items: scm?.staged ?? [] },
                { key: 'changes', title: 'Alterações', items: scm?.changes ?? [] },
              ]"
              :key="group.key"
            >
              <div v-if="group.items.length" class="mk-dim flex items-center gap-1 px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
                <span class="flex-1">{{ group.title }} ({{ group.items.length }})</span>
                <button
                  v-if="!readOnly"
                  type="button"
                  class="mk-hover rounded px-1.5 text-sm leading-5"
                  :title="group.key === 'staged' ? 'Despreparar tudo' : 'Preparar tudo'"
                  :disabled="scmBusy || running"
                  @click="
                    scmRun(
                      group.key === 'staged' ? 'unstage' : 'stage',
                      group.items.map((item) => item.path),
                    )
                  "
                >
                  {{ group.key === 'staged' ? '−' : '+' }}
                </button>
              </div>
              <div
                v-for="item in group.items"
                :key="`${group.key}:${item.path}`"
                class="mk-hover group flex cursor-pointer items-center gap-1.5 py-1 pr-1 pl-3"
                :class="diffing?.path === item.path && diffing.staged === (group.key === 'staged') ? 'mk-selected' : ''"
                :title="item.path"
                data-test="scm-row"
                @click="openDiff(item.path, group.key === 'staged')"
              >
                <img v-if="iconSet" :src="iconSet.fileIcon(item.path)" alt="" class="h-4 w-4 shrink-0" />
                <span class="min-w-0 truncate" :class="STATUS_CLASS[item.status]">{{ nameOf(item.path) }}</span>
                <span class="mk-dim min-w-0 flex-1 truncate text-[10px]">{{ folderOf(item.path) }}</span>
                <button
                  v-if="!readOnly"
                  type="button"
                  class="mk-hover hidden rounded px-1.5 text-sm leading-5 group-hover:block"
                  :title="group.key === 'staged' ? 'Despreparar' : 'Preparar'"
                  :disabled="scmBusy || running"
                  data-test="scm-toggle"
                  @click.stop="scmRun(group.key === 'staged' ? 'unstage' : 'stage', [item.path])"
                >
                  {{ group.key === 'staged' ? '−' : '+' }}
                </button>
                <span class="w-4 shrink-0 text-center font-mono text-[10px]" :class="STATUS_CLASS[item.status]">{{ item.status }}</span>
              </div>
            </template>
            <p v-if="scm && !scm.staged.length && !scm.changes.length" class="mk-dim px-3 pt-3">Nada para commitar.</p>
          </div>
        </div>
      </nav>
      <div class="flex min-w-0 flex-1 flex-col" :class="{ 'max-md:hidden': !active }">
        <button v-if="active" type="button" class="mk-muted m-2 self-start text-xs md:hidden" @click="activeKey = undefined">← Voltar</button>
        <!-- As abas: clique troca, × (ou o botão do meio) fecha; • = alteração não salva. -->
        <div class="mk-tabs flex h-8 shrink-0" data-test="files-tabbar">
          <button
            type="button"
            class="mk-muted mk-hover grid h-8 w-8 shrink-0 place-items-center max-md:hidden"
            :title="sideOpen ? 'Esconder a lateral' : 'Mostrar a lateral'"
            data-test="files-toggle-side"
            @click="sideOpen = !sideOpen"
          >
            <Icon name="panel" class="h-4 w-4 -scale-x-100" />
          </button>
          <div class="flex min-w-0 flex-1 overflow-x-auto" role="tablist" data-test="files-tabs">
            <div
              v-for="item in tabs"
              :key="item.key"
              role="tab"
              :aria-selected="item.key === activeKey"
              class="mk-editor-tab group flex shrink-0 cursor-pointer items-center gap-1.5 pr-1 pl-3 text-xs"
              :class="{ 'mk-editor-tab-on': item.key === activeKey }"
              :title="item.kind === 'diff' ? `${item.path} (${item.staged ? 'preparado' : 'alterações'})` : item.path"
              data-test="files-tab"
              @click="activate(item.key)"
              @auxclick.middle.prevent="closeTab(item.key)"
            >
              <img v-if="iconSet" :src="iconSet.fileIcon(item.path)" alt="" class="h-3.5 w-3.5 shrink-0" />
              <span class="max-w-40 truncate" :class="{ italic: item.kind === 'diff' }">{{ nameOf(item.path) }}</span>
              <span v-if="item.kind === 'diff'" class="mk-dim text-[10px]">{{ item.staged ? 'prep.' : 'diff' }}</span>
              <button
                type="button"
                class="mk-hover grid h-5 w-5 place-items-center rounded"
                :title="item.dirty ? 'Não salvo — fechar' : 'Fechar'"
                data-test="files-tab-close"
                @click.stop="closeTab(item.key)"
              >
                <span v-if="item.dirty" class="mk-fg h-2 w-2 rounded-full bg-current group-hover:hidden" />
                <Icon name="x" class="h-3 w-3" :class="{ 'hidden group-hover:block': item.dirty }" />
              </button>
            </div>
          </div>
        </div>
        <div
          v-if="notice || conflict"
          class="mk-notice flex items-center gap-2 px-3 py-1 text-xs"
          :class="notice?.tone === 'ok' ? 'mk-green' : 'mk-orange'"
          data-test="files-notice"
        >
          <span class="min-w-0 flex-1 truncate">{{ notice?.text }}</span>
          <template v-if="conflict">
            <button type="button" class="mk-hover rounded px-2 py-0.5" data-test="files-take-theirs" @click="takeTheirs">Ficar com a nova</button>
            <button type="button" class="mk-hover rounded px-2 py-0.5" data-test="files-overwrite" @click="save(true)">Sobrescrever</button>
          </template>
          <button v-else type="button" class="mk-hover rounded px-1" title="Fechar o aviso" @click="notice = undefined">
            <Icon name="x" class="h-3 w-3" />
          </button>
        </div>
        <div class="relative min-h-0 flex-1">
          <div v-show="view === 'file' && opened && !opened.binary" ref="host" class="absolute inset-0" data-test="files-editor" />
          <div v-show="view === 'diff' && diffing" ref="diffHost" class="absolute inset-0" data-test="files-diff" />
          <p v-if="view === 'file' && opened?.binary" class="mk-dim p-6 text-center text-sm">Arquivo binário: o editor não abre.</p>
          <p v-else-if="!active" class="mk-dim p-6 text-center text-sm">Escolha um arquivo na árvore ou uma alteração.</p>
        </div>
      </div>
    </div>
    <!-- A barra de status, como nos editores: a branch e o quanto ela está à frente/atrás do remoto. -->
    <footer class="mk-status flex h-6 shrink-0 items-center gap-3 overflow-hidden px-3 text-[11px] whitespace-nowrap" data-test="files-status-bar">
      <span v-if="scm?.branch" class="flex items-center gap-1" :title="scm.upstream ? `${scm.branch} → ${scm.upstream}` : scm.branch">
        <Icon name="git" class="h-3.5 w-3.5" />
        {{ scm.branch }}
      </span>
      <span v-else-if="scm" class="mk-dim">HEAD solto</span>
      <span v-if="scm?.upstream" :title="`${scm.behind} atrás e ${scm.ahead} à frente de ${scm.upstream} (do último fetch)`">↓{{ scm.behind }} ↑{{ scm.ahead }}</span>
      <span
        v-if="view === 'file' && opened && blame"
        class="min-w-0 truncate"
        :title="blame.uncommitted ? 'Linha ainda não commitada' : `${blame.author} · ${blame.summary}`"
        data-test="files-blame"
      >
        {{ blame.uncommitted ? 'Você · não commitado' : `${blame.author}, ${blame.time ? ago(blame.time) : ''}` }}
      </span>
      <span v-if="running" class="mk-badge shrink-0 rounded-full px-2 leading-4" data-test="files-running">agente trabalhando</span>
      <span class="ml-auto" />
      <template v-if="view === 'file' && opened && cursor">
        <span class="shrink-0" data-test="files-cursor">
          Ln {{ cursor.line }}, Col {{ cursor.column }}
          <template v-if="cursor.selected">({{ cursor.selected }} selecionados)</template>
        </span>
        <span class="shrink-0 max-md:hidden">{{ cursor.indent }}</span>
        <span class="shrink-0 max-md:hidden">UTF-8</span>
        <span class="shrink-0 max-md:hidden">{{ cursor.eol }}</span>
        <span class="shrink-0">{{ cursor.language }}</span>
      </template>
      <button type="button" class="mk-hover shrink-0 rounded px-1" title="Atualizar" data-test="files-refresh" @click="loadTree()">
        <Icon name="refresh" class="h-3.5 w-3.5" />
      </button>
    </footer>
  </div>
</template>
