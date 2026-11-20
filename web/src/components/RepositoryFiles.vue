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
  /**
   * 🙈 O que o `.gitignore` esconde, como no VS Code: aparece apagado. Pasta ignorada vem fechada (`pasta/`) e o conteúdo
   * só é lido quando ela abre (`ignoredLoaded`). 🔐 Segredo (`secrets`) aparece com cadeado; o valor, só o admin do projeto.
   */
  const ignored = ref<string[]>([])
  const ignoredLoaded = ref<Array<{ path: string; folder: boolean }>>([])
  const secrets = ref(new Set<string>())
  const canOpenSecrets = ref(false)
  const ignoredDirs = computed(
    () =>
      new Set([
        ...ignored.value.filter((path) => path.endsWith('/')).map((path) => path.slice(0, -1)),
        ...ignoredLoaded.value.filter((entry) => entry.folder).map((entry) => entry.path),
      ]),
  )
  const ignoredFiles = computed(() => [...ignored.value.filter((path) => !path.endsWith('/')), ...ignoredLoaded.value.filter((entry) => !entry.folder).map((entry) => entry.path)])
  /** Está dentro de algo ignorado (para apagar a cor). */
  function isIgnored(path: string): boolean {
    if (ignoredFiles.value.includes(path) || ignoredDirs.value.has(path)) return true
    const parts = path.split('/')
    for (let at = parts.length - 1; at > 0; at -= 1) if (ignoredDirs.value.has(parts.slice(0, at).join('/'))) return true
    return false
  }
  const loadedFolders = new Set<string>()
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
    /** Diff de um commit da Timeline. */
    commit?: string
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
  const tab = ref<'files' | 'search' | 'scm' | 'settings'>('files')

  /**
   * 🔍 BUSCAR (como o Search do VS Code): o termo, com Aa / palavra inteira / regex; arquivos a incluir e excluir (glob);
   * os resultados por arquivo, e o clique abre na linha. Substituir troca em todos (com confirmação).
   */
  const search = ref({ query: '', replace: '', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '', details: false, showReplace: false })
  interface ISearchFile {
    path: string
    matches: Array<{ line: number; column: number; text: string }>
  }
  const results = ref<{ files: ISearchFile[]; total: number; truncated: boolean }>()
  const searching = ref(false)
  const collapsedResults = ref(new Set<string>())
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const searchParams = () => ({
    q: search.value.query,
    case: String(search.value.caseSensitive),
    word: String(search.value.wholeWord),
    regex: String(search.value.regex),
    include: search.value.include,
    exclude: search.value.exclude,
  })
  async function runSearch() {
    clearTimeout(searchTimer)
    if (!search.value.query) return void (results.value = undefined)
    searching.value = true
    try {
      results.value = await api<{ files: ISearchFile[]; total: number; truncated: boolean }>(`/sessions/${encodeURIComponent(props.sessionId)}/search`, { query: searchParams() })
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para buscar.' }
    } finally {
      searching.value = false
    }
  }
  // Busca enquanto digita (com uma folga), como no VS Code.
  watch(
    () => [search.value.query, search.value.caseSensitive, search.value.wholeWord, search.value.regex, search.value.include, search.value.exclude],
    () => {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => void runSearch(), 350)
    },
  )
  async function replaceAll() {
    const found = results.value
    if (!found?.total || props.running) return
    const count = `${found.total} ocorrência${found.total === 1 ? '' : 's'} em ${found.files.length} arquivo${found.files.length === 1 ? '' : 's'}`
    if (!window.confirm(`Substituir ${count} por "${search.value.replace}"?\n\nOs arquivos são gravados na hora (o git mostra o que mudou).`)) return
    try {
      const done = await api<{ files: number; replacements: number }>(`/sessions/${encodeURIComponent(props.sessionId)}/search/replace`, {
        method: 'POST',
        body: { ...searchParams(), replace: search.value.replace },
      })
      notice.value = { tone: 'ok', text: `${done.replacements} troca(s) em ${done.files} arquivo(s).` }
      await loadTree()
      await runSearch()
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para substituir.' }
    }
  }
  /** O trecho achado, destacado na linha. */
  function highlight(text: string): Array<{ text: string; hit: boolean }> {
    if (!search.value.query) return [{ text, hit: false }]
    let pattern: RegExp
    try {
      const source = search.value.regex ? search.value.query : search.value.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      pattern = new RegExp(search.value.wholeWord ? `\\b(?:${source})\\b` : source, `g${search.value.caseSensitive ? '' : 'i'}`)
    } catch {
      return [{ text, hit: false }]
    }
    const parts: Array<{ text: string; hit: boolean }> = []
    let last = 0
    for (const match of text.matchAll(pattern)) {
      if (!match[0]) break
      parts.push({ text: text.slice(last, match.index), hit: false }, { text: match[0], hit: true })
      last = (match.index ?? 0) + match[0].length
    }
    parts.push({ text: text.slice(last), hit: false })
    return parts.filter((part) => part.text)
  }
  /** Abre o arquivo e põe o cursor no trecho achado. */
  async function openAt(path: string, line: number, column: number) {
    await open(path)
    const model = editor?.getModel()
    if (!editor || !model || active.value?.path !== path) return
    const length = highlight(model.getLineContent(Math.min(line, model.getLineCount()))).find((part) => part.hit)?.text.length ?? 0
    editor.setSelection({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column + length })
    editor.revealLineInCenter(line)
    editor.focus()
  }

  // ⚙️ As configurações do editor, por pessoa (no navegador): valem na hora, no editor e no diff.
  interface IEditorSettings {
    fontSize: number
    wordWrap: boolean
    minimap: boolean
    lineNumbers: boolean
    whitespace: boolean
    sideBySide: boolean
    formatOnSave: boolean
    theme: 'monokai' | 'vs-dark'
  }
  const DEFAULT_SETTINGS: IEditorSettings = {
    fontSize: 12,
    wordWrap: false,
    minimap: false,
    lineNumbers: true,
    whitespace: false,
    sideBySide: true,
    formatOnSave: true,
    theme: 'monokai',
  }
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
      timeline.value = undefined
      void loadTimeline(timelinePath.value)
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
  async function openDiff(path: string, staged: boolean, commit?: string) {
    notice.value = undefined
    const key = commit ? `diff:commit:${commit}:${path}` : `diff:${staged ? 'staged' : 'work'}:${path}`
    try {
      const diff = await api<{ original: string; modified: string }>(`${scmBase()}/diff`, { query: { path, staged: String(staged), ...(commit ? { commit } : {}) } })
      const loaded = monaco.value ?? (await import('@/lib/monaco')).monaco
      monaco.value = loaded
      const language = loaded.languages.getLanguages().find((one) => one.extensions?.some((extension) => path.toLowerCase().endsWith(extension)))?.id
      // Reabrir relê: o arquivo pode ter mudado desde a última vez.
      const old = buffers.get(key)
      if (activeKey.value === key) diffEditor?.setModel(null)
      old?.original?.dispose()
      old?.modified?.dispose()
      buffers.set(key, { original: loaded.editor.createModel(diff.original, language), modified: loaded.editor.createModel(diff.modified, language) })
      if (!tabs.value.some((one) => one.key === key)) tabs.value.push({ key, kind: 'diff', path, staged, ...(commit ? { commit } : {}), dirty: false })
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
      const result = await api<{ files: string[]; ignored?: string[]; secrets?: string[]; canOpenSecrets?: boolean; truncated: boolean; status?: Record<string, TStatus> }>(base())
      ignored.value = result.ignored ?? []
      secrets.value = new Set(result.secrets ?? [])
      canOpenSecrets.value = !!result.canOpenSecrets
      // As pastas ignoradas que estavam abertas voltam a ler o que têm (pode ter mudado).
      ignoredLoaded.value = []
      const reopen = [...loadedFolders]
      loadedFolders.clear()
      for (const folder of reopen) if (expanded.value.has(folder)) void loadIgnoredFolder(folder)
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
      return [...files.value, ...ignoredFiles.value]
        .filter((path) => path.toLowerCase().includes(term))
        .slice(0, 500)
        .map((path) => ({ path, name: path, depth: 0, folder: false }))
    // Como no VS Code: em cada nível, as PASTAS primeiro e depois os arquivos, cada grupo em ordem alfabética.
    const out: IRow[] = []
    const walk = (node: ITreeNode, depth: number) => {
      for (const child of node.children) {
        const folder = child.children.length > 0 || ignoredDirs.value.has(child.path)
        out.push({ path: child.path, name: child.name, depth, folder })
        if (folder && expanded.value.has(child.path)) walk(child, depth + 1)
      }
    }
    walk(tree.value, 0)
    return out
  })

  interface ITreeNode {
    name: string
    path: string
    children: ITreeNode[]
  }
  const byName = (a: ITreeNode, b: ITreeNode) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  /** A árvore montada da lista do git (pastas antes, em ordem alfabética). */
  const tree = computed<ITreeNode>(() => {
    const root: ITreeNode = { name: '', path: '', children: [] }
    const index = new Map<string, ITreeNode>([['', root]])
    for (const path of [...files.value, ...ignoredFiles.value, ...ignoredDirs.value]) {
      const parts = path.split('/')
      for (let at = 0; at < parts.length; at += 1) {
        const sub = parts.slice(0, at + 1).join('/')
        if (index.has(sub)) continue
        const node: ITreeNode = { name: parts[at], path: sub, children: [] }
        index.set(sub, node)
        index.get(parts.slice(0, at).join('/'))!.children.push(node)
      }
    }
    const sort = (node: ITreeNode) => {
      const isFolder = (child: ITreeNode) => child.children.length > 0 || ignoredDirs.value.has(child.path)
      const folders = node.children.filter(isFolder).sort(byName)
      const leaves = node.children.filter((child) => !isFolder(child)).sort(byName)
      node.children = [...folders, ...leaves]
      for (const folder of folders) sort(folder)
    }
    sort(root)
    return root
  })

  /**
   * 🕘 A TIMELINE (como no VS Code): os commits que mexeram no arquivo aberto, embaixo da árvore. O clique abre o diff
   * daquele commit numa aba. Recolhível (lembrado no navegador).
   */
  const timelineOpen = ref(remembered('gw.files.timeline', '1') === '1')
  /** A altura da Timeline: fixa, com rolagem própria; a linha de cima arrasta (lembrada no navegador). */
  const timelineHeight = ref(Number(remembered('gw.files.timelineHeight', '180')) || 180)
  let timelineDrag: { y: number; height: number } | undefined
  function startTimelineDrag(event: PointerEvent) {
    timelineDrag = { y: event.clientY, height: timelineHeight.value }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  function onTimelineDrag(event: PointerEvent) {
    if (!timelineDrag) return
    timelineHeight.value = Math.min(600, Math.max(80, timelineDrag.height - (event.clientY - timelineDrag.y)))
  }
  function stopTimelineDrag() {
    if (!timelineDrag) return
    timelineDrag = undefined
    remember('gw.files.timelineHeight', String(Math.round(timelineHeight.value)))
  }
  watch(timelineOpen, (open) => remember('gw.files.timeline', open ? '1' : '0'))
  const timeline = ref<{ path: string; commits: Array<{ sha: string; author: string; time: number; subject: string }> }>()
  const timelinePath = computed(() => active.value?.path)
  async function loadTimeline(path: string | undefined) {
    if (!path || !timelineOpen.value) return
    if (timeline.value?.path === path) return
    const result = await api<{ commits: Array<{ sha: string; author: string; time: number; subject: string }> }>(`${scmBase()}/history`, { query: { path } }).catch(() => undefined)
    if (timelinePath.value === path) timeline.value = { path, commits: result?.commits ?? [] }
  }
  watch([timelinePath, timelineOpen], ([path]) => void loadTimeline(path))

  /**
   * 🖱️ O MENU DO BOTÃO DIREITO na árvore (arquivo ou pasta): recortar, copiar, colar, renomear (na própria linha) e
   * excluir; e ARRASTAR E SOLTAR sobre uma pasta para mover. Tudo pelo servidor, com as travas de lá (sem segredo, sem
   * `.git`, nunca com o agente trabalhando).
   */
  const menu = ref<{ x: number; y: number; path: string; folder: boolean }>()
  const renaming = ref<{ path: string; name: string }>()
  const clipboard = ref<{ path: string; mode: 'cut' | 'copy' }>()
  function openMenu(event: MouseEvent, row: IRow) {
    if (props.readOnly || !editable.value) return
    menu.value = { x: event.clientX, y: event.clientY, path: row.path, folder: row.folder }
  }
  function closeMenu() {
    menu.value = undefined
  }
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`)
  /** As abas de arquivos dentro do caminho: com alteração não salva, a operação não segue. */
  function tabsUnder(path: string) {
    return tabs.value.filter((tab) => under(tab.path, path))
  }
  function blockedByDirty(path: string, action: string): boolean {
    if (!tabsUnder(path).some((tab) => tab.dirty)) return false
    notice.value = { tone: 'error', text: `Salve (ou descarte) as alterações abertas antes de ${action}.` }
    return true
  }
  async function closeTabsUnder(path: string) {
    for (const tab of tabsUnder(path)) {
      tab.dirty = false
      await closeTab(tab.key)
    }
  }
  function busy(): boolean {
    if (!props.running) return false
    notice.value = { tone: 'error', text: 'O agente está trabalhando. Espere ele terminar.' }
    return true
  }
  /** Leva `path` para dentro de `folder` (mover ou copiar). Copiar num lugar onde o nome já existe ganha " copia". */
  async function transfer(path: string, folder: string, mode: 'cut' | 'copy') {
    if (busy()) return
    if (mode === 'cut' && (folderOf(path) === folder || under(folder, path))) return
    if (mode === 'cut' && blockedByDirty(path, 'mover')) return
    const name = nameOf(path)
    let target = folder ? `${folder}/${name}` : name
    if (mode === 'copy') {
      const taken = (candidate: string) => files.value.some((file) => under(file, candidate))
      const dot = name.lastIndexOf('.')
      for (let index = 1; taken(target) && index < 50; index += 1) {
        const suffix = index === 1 ? ' copia' : ` copia ${index}`
        const copyName = dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`
        target = folder ? `${folder}/${copyName}` : copyName
      }
    }
    try {
      await api(`${base()}/${mode === 'cut' ? 'rename' : 'copy'}`, { method: 'POST', body: { from: path, to: target } })
      if (mode === 'cut') await closeTabsUnder(path)
      if (folder) expanded.value = new Set([...expanded.value, folder])
      await loadTree()
      notice.value = { tone: 'ok', text: `${mode === 'cut' ? 'Movido' : 'Copiado'} para ${target}.` }
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu.' }
    }
  }
  function cut(path: string) {
    clipboard.value = { path, mode: 'cut' }
    closeMenu()
  }
  function copy(path: string) {
    clipboard.value = { path, mode: 'copy' }
    closeMenu()
  }
  async function paste(target: { path: string; folder: boolean }) {
    closeMenu()
    const item = clipboard.value
    if (!item) return
    await transfer(item.path, target.folder ? target.path : folderOf(target.path), item.mode)
    if (item.mode === 'cut') clipboard.value = undefined
  }
  function startRename(path: string) {
    closeMenu()
    if (blockedByDirty(path, 'renomear')) return
    renaming.value = { path, name: nameOf(path) }
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('[data-test="files-rename-input"]')
      input?.focus()
      const dot = input?.value.lastIndexOf('.') ?? -1
      input?.setSelectionRange(0, dot > 0 ? dot : (input?.value.length ?? 0))
    })
  }
  async function commitRename() {
    const current = renaming.value
    renaming.value = undefined
    if (!current) return
    const name = current.name.trim()
    if (!name || name === nameOf(current.path) || name.includes('/')) return
    if (busy()) return
    const folder = folderOf(current.path)
    const to = folder ? `${folder}/${name}` : name
    try {
      await api(`${base()}/rename`, { method: 'POST', body: { from: current.path, to } })
      const wasOpen = tabs.value.some((tab) => tab.key === `file:${current.path}`)
      await closeTabsUnder(current.path)
      await loadTree()
      if (wasOpen) await open(to)
      notice.value = { tone: 'ok', text: `Renomeado para ${name}.` }
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para renomear.' }
    }
  }
  async function removeFile(path: string, folder = false) {
    closeMenu()
    if (busy()) return
    const inside = folder ? files.value.filter((file) => under(file, path)).length : 0
    const what = folder ? `a pasta ${path} (${inside} arquivo${inside === 1 ? '' : 's'})` : path
    if (!window.confirm(`Excluir ${what}?\n\nSai do disco. O que estava commitado o git ainda tem.`)) return
    try {
      await api(base(), { method: 'DELETE', query: { path } })
      await closeTabsUnder(path)
      await loadTree()
      notice.value = { tone: 'ok', text: `${nameOf(path)} excluíd${folder ? 'a' : 'o'}.` }
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para excluir.' }
    }
  }

  /** ⌘X / ⌘C / ⌘V / Delete / Enter (renomear) com uma linha da árvore em foco (o clique nela já a foca). */
  function onTreeKey(event: KeyboardEvent) {
    if (props.readOnly || !editable.value || renaming.value || creating.value) return
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-test="files-row"]')
    const path = row?.title
    if (!path) return
    const folder = rows.value.find((one) => one.path === path)?.folder ?? false
    const key = event.key.toLowerCase()
    if ((event.metaKey || event.ctrlKey) && ['x', 'c', 'v'].includes(key)) {
      event.preventDefault()
      if (key === 'x') cut(path)
      else if (key === 'c') copy(path)
      else void paste({ path, folder })
    } else if (event.key === 'Delete' || (event.metaKey && event.key === 'Backspace')) {
      event.preventDefault()
      void removeFile(path, folder)
    } else if (event.key === 'Enter' && !event.metaKey && !folder) {
      event.preventDefault()
      startRename(path)
    }
  }

  /**
   * 📄 NOVO ARQUIVO: na pasta selecionada (a última clicada na árvore) ou na do arquivo aberto. O nome aceita subpasta
   * existente (`components/X.vue`); o arquivo nasce vazio e abre.
   */
  const selectedFolder = ref('')
  const creating = ref<{ folder: string; name: string }>()
  function startCreate() {
    if (props.readOnly || !editable.value) return
    const folder = selectedFolder.value || (active.value ? folderOf(active.value.path) : '')
    if (folder) expanded.value = new Set([...expanded.value, ...folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))])
    creating.value = { folder, name: '' }
    void nextTick(() => document.querySelector<HTMLInputElement>('[data-test="files-create-input"]')?.focus())
  }
  async function commitCreate() {
    const current = creating.value
    creating.value = undefined
    const name = current?.name.trim().replace(/^\/+/, '')
    if (!current || !name || name.split('/').some((part) => part === '..' || part === '')) return
    if (busy()) return
    const path = current.folder ? `${current.folder}/${name}` : name
    if (files.value.includes(path)) return void (notice.value = { tone: 'error', text: `${path} já existe.` })
    try {
      await api(base(), { method: 'PUT', body: { path, content: '' } })
      await loadTree()
      await open(path)
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para criar o arquivo.' }
    }
  }

  // ✋ Arrastar e soltar: o item vai para a pasta onde cai (num arquivo, a pasta dele; no vazio, a raiz).
  const dragging = ref<string>()
  const dropTarget = ref<string>()
  function onDragStart(event: DragEvent, row: IRow) {
    if (props.readOnly || !editable.value) return event.preventDefault()
    dragging.value = row.path
    event.dataTransfer?.setData('text/plain', row.path)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }
  function dropFolderOf(row: IRow | undefined): string {
    return !row ? '' : row.folder ? row.path : folderOf(row.path)
  }
  function onDragOver(event: DragEvent, row?: IRow) {
    const source = dragging.value
    if (!source) return
    const folder = dropFolderOf(row)
    if (under(folder, source) || folderOf(source) === folder) return void (dropTarget.value = undefined)
    event.preventDefault()
    dropTarget.value = folder
  }
  async function onDrop(event: DragEvent, row?: IRow) {
    event.preventDefault()
    const source = dragging.value
    const folder = dropFolderOf(row)
    dragging.value = undefined
    dropTarget.value = undefined
    if (source) await transfer(source, folder, 'cut')
  }
  function onDragEnd() {
    dragging.value = undefined
    dropTarget.value = undefined
  }

  function toggle(path: string) {
    const next = new Set(expanded.value)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (ignoredDirs.value.has(path)) void loadIgnoredFolder(path)
    }
    expanded.value = next
  }

  /** Abre uma pasta ignorada: o que tem dentro (um nível), pelo servidor. */
  async function loadIgnoredFolder(path: string) {
    if (loadedFolders.has(path)) return
    loadedFolders.add(path)
    const result = await api<{ entries: Array<{ path: string; folder: boolean }> }>(`${base()}/folder`, { query: { path } }).catch(() => undefined)
    if (!result) return void loadedFolders.delete(path)
    const known = new Set(ignoredLoaded.value.map((entry) => entry.path))
    ignoredLoaded.value = [...ignoredLoaded.value, ...result.entries.filter((entry) => !known.has(entry.path))]
  }

  const extrasCleanup: Array<() => void> = []

  /**
   * 🔎 ESLINT: o do repositório, no cerco (ver `GET /sessions/:id/lint`), ao abrir e ao salvar o arquivo. Os problemas
   * viram os sublinhados do Monaco (e o Error Lens os escreve no fim da linha). Sem ESLint no repositório: nada.
   */
  const LINT_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/i
  const lintNote = ref<string>()
  async function lint(path: string) {
    const model = buffers.get(`file:${path}`)?.model
    const loaded = monaco.value
    if (!model || !loaded || !LINT_EXT.test(path)) return
    const result = await api<{
      status: string
      reason?: string
      messages: Array<{ line: number; column: number; endLine?: number; endColumn?: number; severity: 1 | 2; message: string; ruleId?: string }>
    }>(`/sessions/${encodeURIComponent(props.sessionId)}/lint`, { query: { path } }).catch(() => undefined)
    if (!result || model.isDisposed()) return
    if (active.value?.path === path) lintNote.value = result.status === 'ok' ? undefined : result.reason
    loaded.editor.setModelMarkers(
      model,
      'eslint',
      result.messages.map((message) => ({
        startLineNumber: message.line,
        startColumn: message.column,
        endLineNumber: message.endLine ?? message.line,
        endColumn: message.endColumn ?? model.getLineMaxColumn(Math.min(message.line, model.getLineCount())),
        severity: message.severity === 2 ? loaded.MarkerSeverity.Error : loaded.MarkerSeverity.Warning,
        message: message.message,
        source: 'eslint',
        ...(message.ruleId ? { code: message.ruleId } : {}),
      })),
    )
  }
  /** Os problemas do arquivo aberto (o contador da barra de baixo). */
  const problems = ref<{ errors: number; warnings: number }>({ errors: 0, warnings: 0 })
  function countProblems() {
    const model = editor?.getModel()
    const loaded = monaco.value
    if (!model || !loaded) return void (problems.value = { errors: 0, warnings: 0 })
    const markers = loaded.editor.getModelMarkers({ resource: model.uri })
    problems.value = {
      errors: markers.filter((marker) => marker.severity === loaded.MarkerSeverity.Error).length,
      warnings: markers.filter((marker) => marker.severity === loaded.MarkerSeverity.Warning).length,
    }
  }

  /**
   * 🏷️ Os aliases do TypeScript do arquivo: os `paths` do tsconfig.json mais próximo (seguindo o `extends`). Lidos uma
   * vez por tsconfig; o tsconfig é lido como DADO (JSON com comentário), nunca executado.
   */
  const aliasCache = new Map<string, Promise<import('@/lib/editorExtras').IPathAlias[]>>()
  async function aliasesFor(path: string) {
    const parts = path.split('/').slice(0, -1)
    let tsconfig: string | undefined
    for (let depth = parts.length; depth >= 0; depth -= 1) {
      const candidate = [...parts.slice(0, depth), 'tsconfig.json'].join('/')
      if (files.value.includes(candidate)) {
        tsconfig = candidate
        break
      }
    }
    if (!tsconfig) return []
    let cached = aliasCache.get(tsconfig)
    if (!cached) {
      const { tsconfigAliases } = await import('@/lib/editorExtras')
      cached = tsconfigAliases(tsconfig, async (file) => (await api<IFile>(base(), { query: { path: file } }).catch(() => undefined))?.content)
      aliasCache.set(tsconfig, cached)
    }
    return cached
  }

  async function ensureEditor() {
    if (editor || !host.value) return
    const loaded = (await import('@/lib/monaco')).monaco
    monaco.value = loaded
    await (await import('@/lib/editorExtras')).registerExtraLanguages(loaded)
    await (await import('@/lib/schemas')).registerSchemas(loaded)
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
    editor.addAction({
      id: 'gateway.prettier.format',
      label: 'Formatar documento (Prettier)',
      keybindings: [loaded.KeyMod.Shift | loaded.KeyMod.Alt | loaded.KeyCode.KeyF],
      contextMenuGroupId: '1_modification',
      run: () => void format(),
    })
    editor.onDidChangeCursorSelection(() => readCursor())
    // 🧩 Error Lens e Better Comments (ver `@/lib/editorExtras`).
    const extras = await import('@/lib/editorExtras')
    extrasCleanup.push(extras.errorLens(loaded, editor), extras.betterComments(loaded, editor))
    // 📎 import './' → as pastas e arquivos da árvore (a URI do modelo é `/<conversa>/<caminho>`).
    const sessionPrefix = `/${props.sessionId}/`
    extrasCleanup.push(
      extras.importPathCompletion(
        loaded,
        () => files.value,
        (model) => (model.uri.path.startsWith(sessionPrefix) ? decodeURIComponent(model.uri.path.slice(sessionPrefix.length)) : undefined),
        aliasesFor,
      ),
    )
    editor.onDidChangeModel(() => {
      readCursor()
      countProblems()
    })
    extrasCleanup.push(loaded.editor.onDidChangeMarkers(() => countProblems()).dispose)
  }

  async function open(path: string) {
    notice.value = undefined
    if (secrets.value.has(path) && !canOpenSecrets.value) {
      notice.value = { tone: 'error', text: '🔐 Arquivo de segredo: só o admin do projeto abre.' }
      return
    }
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
      void lint(path)
      void import('@/lib/schemas').then((schemas) => schemas.ensureSchemaFor(path)).catch(() => undefined)
    } catch (failure) {
      notice.value = { tone: 'error', text: failure instanceof Error ? failure.message : 'Não deu para abrir.' }
    }
  }

  /**
   * ✨ PRETTIER (no navegador, ver `@/lib/prettier`): a config do repositório é lida uma vez por conversa, como dado
   * (`.prettierrc` JSON/YAML ou a chave do `package.json`); o `.prettierignore` vale por prefixo de caminho.
   */
  let prettierSetup: Promise<{ config?: import('prettier').Options; ignore: string[] }> | undefined
  async function readText(path: string): Promise<string | undefined> {
    if (!files.value.includes(path)) return undefined
    return (await api<IFile>(base(), { query: { path } }).catch(() => undefined))?.content
  }
  function loadPrettierSetup() {
    prettierSetup ??= (async () => {
      const { parseConfig } = await import('@/lib/prettier')
      let config: import('prettier').Options | undefined
      for (const name of ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', 'package.json']) {
        const content = await readText(name)
        if (content === undefined) continue
        try {
          config = await parseConfig({ name, content })
        } catch {
          config = undefined
        }
        if (config) break
      }
      const ignore = ((await readText('.prettierignore')) ?? '')
        .split('\n')
        .map((line) =>
          line
            .trim()
            .replace(/^\//, '')
            .replace(/\/\*\*?$/, '/'),
        )
        .filter((line) => line && !line.startsWith('#') && !/[*?[]/.test(line))
      return { config, ignore }
    })()
    return prettierSetup
  }
  /** Formata a aba ativa (desfazível com ⌘Z). `quiet`: ao salvar, sem aviso quando o arquivo não tem formatador. */
  async function format(quiet = false): Promise<void> {
    const tab = active.value
    const model = editor?.getModel()
    if (!editor || !model || tab?.kind !== 'file' || !editable.value) return
    try {
      const { formatText, parserFor } = await import('@/lib/prettier')
      if (!parserFor(tab.path)) {
        if (!quiet) notice.value = { tone: 'error', text: 'O Prettier não formata este tipo de arquivo.' }
        return
      }
      const setup = await loadPrettierSetup()
      if (setup.ignore.some((rule) => tab.path === rule || tab.path.startsWith(rule.endsWith('/') ? rule : `${rule}/`))) return
      const text = model.getValue()
      const formatted = await formatText(tab.path, text, setup.config)
      if (formatted === undefined || formatted === text) return
      editor.pushUndoStop()
      editor.executeEdits('prettier', [{ range: model.getFullModelRange(), text: formatted }])
      editor.pushUndoStop()
    } catch (failure) {
      notice.value = { tone: 'error', text: `Prettier: ${failure instanceof Error ? failure.message.split('\n')[0] : 'não deu para formatar'}` }
    }
  }

  async function save(force = false) {
    const tab = active.value
    if (!editor || tab?.kind !== 'file' || !tab.file || !editable.value || saving.value) return
    if (props.running) return void (notice.value = { tone: 'error', text: 'O agente está trabalhando. Salve quando ele terminar.' })
    saving.value = true
    notice.value = undefined
    if (settings.value.formatOnSave) await format(true)
    const content = editor.getValue()
    try {
      const baseHash = force && conflict.value ? conflict.value.hash : tab.file.hash
      const saved = await api<IFile>(base(), { method: 'PUT', body: { path: tab.path, content, baseHash } })
      tab.file = { ...saved, content }
      tab.dirty = false
      conflict.value = undefined
      notice.value = { tone: 'ok', text: 'Salvo.' }
      void loadTree()
      void lint(tab.path)
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
      prettierSetup = undefined
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
    for (const cleanup of extrasCleanup.splice(0)) cleanup()
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
          <button type="button" role="tab" class="mk-tab flex-1 py-2" :class="{ 'mk-tab-on': tab === 'files' }" title="Arquivos" data-test="files-tab-files" @click="tab = 'files'">
            <Icon name="folder" class="mx-auto h-4 w-4" />
          </button>
          <button
            type="button"
            role="tab"
            class="mk-tab flex-1 py-2"
            :class="{ 'mk-tab-on': tab === 'search' }"
            title="Buscar nos arquivos"
            data-test="files-tab-search"
            @click="tab = 'search'"
          >
            <Icon name="search" class="mx-auto h-4 w-4" />
          </button>
          <button
            type="button"
            role="tab"
            class="mk-tab relative flex-1 py-2"
            :class="{ 'mk-tab-on': tab === 'scm' }"
            title="Alterações"
            data-test="files-tab-scm"
            @click="tab = 'scm'"
          >
            <Icon name="git" class="mx-auto h-4 w-4" />
            <span v-if="scm && scm.staged.length + scm.changes.length" class="mk-count absolute top-0.5 right-1/2 translate-x-4 rounded-full px-1 text-[9px] leading-4">
              {{ scm.staged.length + scm.changes.length }}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            class="mk-tab flex-1 py-2"
            :class="{ 'mk-tab-on': tab === 'settings' }"
            title="Configurações do editor"
            data-test="files-tab-settings"
            @click="tab = 'settings'"
          >
            <Icon name="settings" class="mx-auto h-4 w-4" />
          </button>
        </div>
        <template v-if="tab === 'files'">
          <div class="flex items-center gap-1 p-2">
            <button
              v-if="!readOnly && editable"
              type="button"
              class="mk-hover mk-muted grid h-8 w-8 shrink-0 place-items-center rounded-md"
              :title="`Novo arquivo em ${selectedFolder || (active ? folderOf(active.path) : '') || 'raiz'}/`"
              data-test="files-new"
              @click="startCreate"
            >
              <Icon name="plus" class="h-4 w-4" />
            </button>
            <input v-model="filter" type="search" placeholder="Buscar arquivo" class="mk-input h-8 min-w-0 flex-1 rounded-md px-2 text-xs outline-none" data-test="files-filter" />
          </div>
          <div v-if="creating" class="flex items-center gap-1 px-2 pb-2 text-xs">
            <span class="mk-dim shrink-0 truncate" :title="creating.folder || 'raiz'">{{ creating.folder ? `${creating.folder}/` : '/' }}</span>
            <input
              v-model="creating.name"
              type="text"
              placeholder="nome-do-arquivo.ts"
              spellcheck="false"
              class="mk-input h-7 min-w-0 flex-1 rounded px-2 outline-none"
              data-test="files-create-input"
              @keydown.enter.prevent="commitCreate"
              @keydown.escape.prevent="creating = undefined"
              @blur="commitCreate"
            />
          </div>
          <div
            class="min-h-0 flex-1 overflow-y-auto pb-2 text-xs"
            :class="{ 'mk-drop-root': dropTarget === '' }"
            @dragover.self="onDragOver($event)"
            @drop.self="onDrop($event)"
            @keydown="onTreeKey"
          >
            <p v-if="loadError" class="mk-orange px-3">{{ loadError }}</p>
            <template v-for="row in rows" :key="row.path">
              <input
                v-if="renaming && row.path === renaming.path"
                v-model="renaming!.name"
                class="mk-input my-0.5 h-6 w-[calc(100%-1rem)] rounded px-1 text-xs outline-none"
                :style="{ marginLeft: `${8 + row.depth * 12 + 16}px` }"
                data-test="files-rename-input"
                @keydown.enter.prevent="commitRename"
                @keydown.escape.prevent="renaming = undefined"
                @blur="commitRename"
              />
              <button
                v-else
                type="button"
                class="mk-hover flex w-full items-center gap-1 truncate py-1 pr-2 text-left"
                :class="[
                  opened?.path === row.path ? 'mk-selected' : row.folder ? 'mk-fg' : 'mk-muted',
                  !row.folder && status[row.path] ? STATUS_CLASS[status[row.path]] : '',
                  row.folder && changedFolders.has(row.path) ? 'mk-modified' : '',
                  dropTarget !== undefined && row.folder && dropTarget === row.path ? 'mk-drop' : '',
                  isIgnored(row.path) ? 'mk-ignored' : '',
                  clipboard?.mode === 'cut' && under(row.path, clipboard.path) ? 'opacity-50' : '',
                ]"
                :style="{ paddingLeft: `${8 + row.depth * 12}px` }"
                :title="row.path"
                data-test="files-row"
                @click="((selectedFolder = row.folder ? row.path : folderOf(row.path)), row.folder ? toggle(row.path) : open(row.path))"
                @contextmenu.prevent="openMenu($event, row)"
                :draggable="!readOnly && editable"
                @dragstart="onDragStart($event, row)"
                @dragover="onDragOver($event, row)"
                @drop="onDrop($event, row)"
                @dragend="onDragEnd"
              >
                <span class="mk-dim w-3 shrink-0">{{ row.folder ? (expanded.has(row.path) ? '▾' : '▸') : '' }}</span>
                <img v-if="iconOf(row)" :src="iconOf(row)" alt="" class="h-4 w-4 shrink-0" loading="lazy" />
                <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
                <span
                  v-if="secrets.has(row.path)"
                  class="shrink-0 text-[10px]"
                  :title="canOpenSecrets ? 'Segredo (você é admin do projeto)' : 'Segredo: só o admin do projeto abre'"
                  data-test="files-secret"
                >
                  🔐
                </span>
                <span v-if="!row.folder && status[row.path]" class="shrink-0 font-mono text-[10px]" data-test="files-status">{{ status[row.path] }}</span>
                <span v-else-if="row.folder && changedFolders.has(row.path)" class="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
              </button>
            </template>
            <p v-if="truncated" class="mk-dim px-3 pt-2">Lista cortada em 20 mil arquivos: use a busca.</p>
          </div>
          <section
            class="mk-border relative flex shrink-0 flex-col border-t text-xs"
            :style="timelineOpen ? { height: `${timelineHeight}px` } : undefined"
            data-test="files-timeline"
          >
            <div
              v-if="timelineOpen"
              class="absolute -top-1 left-0 z-10 h-2 w-full cursor-row-resize hover:bg-[#75715e]/40"
              data-test="files-timeline-resize"
              @pointerdown="startTimelineDrag"
              @pointermove="onTimelineDrag"
              @pointerup="stopTimelineDrag"
            />
            <button
              type="button"
              class="mk-section-head flex items-center gap-1 px-2 py-1 text-left text-xs font-semibold"
              data-test="files-timeline-toggle"
              @click="timelineOpen = !timelineOpen"
            >
              <span class="mk-dim w-3">{{ timelineOpen ? '▾' : '▸' }}</span>
              <span class="mk-fg">Timeline</span>
              <span v-if="timelinePath" class="mk-dim min-w-0 truncate font-normal">{{ nameOf(timelinePath) }}</span>
            </button>
            <div v-if="timelineOpen" class="min-h-0 flex-1 overflow-y-auto pb-1">
              <p v-if="!timelinePath" class="mk-dim px-3 py-1">Abra um arquivo para ver os commits dele.</p>
              <p v-else-if="timeline?.path === timelinePath && !timeline.commits.length" class="mk-dim px-3 py-1">Sem commits (arquivo novo).</p>
              <button
                v-for="item in timeline && timeline.path === timelinePath ? timeline.commits : []"
                :key="item.sha"
                type="button"
                class="mk-hover mk-timeline-item relative flex w-full items-center gap-2 py-1 pr-2 pl-3 text-left"
                :class="{ 'mk-selected': active?.commit === item.sha }"
                :title="`${item.subject}\n${item.author} · ${item.sha.slice(0, 7)}`"
                data-test="files-timeline-item"
                @click="timelinePath && openDiff(timelinePath, false, item.sha)"
              >
                <span class="mk-timeline-dot" aria-hidden="true" />
                <span class="mk-fg min-w-0 flex-1 truncate">{{ item.subject }}</span>
                <span class="mk-dim shrink-0 text-[10px]">{{ ago(item.time) }}</span>
              </button>
            </div>
          </section>
        </template>
        <div v-else-if="tab === 'search'" class="flex min-h-0 flex-1 flex-col text-xs" data-test="files-search">
          <div class="flex flex-col gap-1.5 p-2">
            <div class="flex items-start gap-1">
              <button
                type="button"
                class="mk-hover mk-muted mt-1 grid h-6 w-4 shrink-0 place-items-center rounded"
                :title="search.showReplace ? 'Esconder substituir' : 'Substituir'"
                data-test="search-toggle-replace"
                @click="search.showReplace = !search.showReplace"
              >
                {{ search.showReplace ? '▾' : '▸' }}
              </button>
              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <div class="mk-input flex items-center rounded-md pr-1">
                  <input
                    v-model="search.query"
                    type="text"
                    placeholder="Buscar"
                    spellcheck="false"
                    class="h-7 min-w-0 flex-1 bg-transparent px-2 outline-none"
                    data-test="search-query"
                    @keydown.enter.prevent="runSearch"
                  />
                  <button
                    type="button"
                    class="search-flag"
                    :class="{ on: search.caseSensitive }"
                    title="Diferenciar maiúsculas"
                    @click="search.caseSensitive = !search.caseSensitive"
                  >
                    Aa
                  </button>
                  <button type="button" class="search-flag underline" :class="{ on: search.wholeWord }" title="Palavra inteira" @click="search.wholeWord = !search.wholeWord">
                    ab
                  </button>
                  <button type="button" class="search-flag" :class="{ on: search.regex }" title="Expressão regular" data-test="search-regex" @click="search.regex = !search.regex">
                    .*
                  </button>
                </div>
                <div v-if="search.showReplace" class="flex items-center gap-1">
                  <input
                    v-model="search.replace"
                    type="text"
                    placeholder="Substituir"
                    spellcheck="false"
                    class="mk-input h-7 min-w-0 flex-1 rounded-md px-2 outline-none"
                    data-test="search-replace"
                  />
                  <button
                    type="button"
                    class="mk-hover mk-muted h-7 shrink-0 rounded px-2"
                    :disabled="readOnly || running || !results?.total"
                    :title="running ? 'Espere o agente terminar' : 'Substituir tudo'"
                    data-test="search-replace-all"
                    @click="replaceAll"
                  >
                    Trocar tudo
                  </button>
                </div>
              </div>
            </div>
            <button type="button" class="mk-dim self-end px-1 text-[11px]" data-test="search-details" @click="search.details = !search.details">⋯ incluir / excluir</button>
            <template v-if="search.details">
              <label class="mk-muted text-[11px]">arquivos a incluir</label>
              <input
                v-model="search.include"
                type="text"
                placeholder="ex.: src, *.ts"
                spellcheck="false"
                class="mk-input h-7 rounded-md px-2 outline-none"
                data-test="search-include"
              />
              <label class="mk-muted text-[11px]">arquivos a excluir</label>
              <input
                v-model="search.exclude"
                type="text"
                placeholder="ex.: *.test.ts, dist"
                spellcheck="false"
                class="mk-input h-7 rounded-md px-2 outline-none"
                data-test="search-exclude"
              />
            </template>
          </div>
          <p v-if="searching" class="mk-dim px-3">Buscando…</p>
          <p v-else-if="results" class="mk-dim px-3 pb-1">
            {{ results.total }} resultado{{ results.total === 1 ? '' : 's' }} em {{ results.files.length }} arquivo{{ results.files.length === 1 ? '' : 's' }}
            <template v-if="results.truncated">(cortado: refine a busca)</template>
          </p>
          <div class="min-h-0 flex-1 overflow-y-auto pb-2" data-test="search-results">
            <template v-for="file in results?.files ?? []" :key="file.path">
              <button
                type="button"
                class="mk-hover flex w-full items-center gap-1.5 py-1 pr-2 pl-2 text-left"
                :title="file.path"
                data-test="search-file"
                @click="collapsedResults.has(file.path) ? collapsedResults.delete(file.path) : collapsedResults.add(file.path)"
              >
                <span class="mk-dim w-3 shrink-0">{{ collapsedResults.has(file.path) ? '▸' : '▾' }}</span>
                <img v-if="iconSet" :src="iconSet.fileIcon(file.path)" alt="" class="h-4 w-4 shrink-0" />
                <span class="mk-fg min-w-0 truncate">{{ nameOf(file.path) }}</span>
                <span class="mk-dim min-w-0 flex-1 truncate text-[10px]">{{ folderOf(file.path) }}</span>
                <span class="mk-count shrink-0 rounded-full px-1.5 text-[10px]">{{ file.matches.length }}</span>
              </button>
              <template v-if="!collapsedResults.has(file.path)">
                <button
                  v-for="match in file.matches"
                  :key="`${file.path}:${match.line}:${match.column}`"
                  type="button"
                  class="mk-hover mk-muted block w-full truncate py-0.5 pr-2 pl-8 text-left font-mono text-[11px]"
                  :title="`${file.path}:${match.line}`"
                  data-test="search-match"
                  @click="openAt(file.path, match.line, match.column)"
                >
                  <template v-for="(part, index) in highlight(match.text.trimStart())" :key="index">
                    <span :class="part.hit ? 'search-hit' : ''">{{ part.text }}</span>
                  </template>
                </button>
              </template>
            </template>
          </div>
        </div>
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
              { key: 'formatOnSave', label: 'Formatar ao salvar (Prettier)' },
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
              :title="item.kind === 'diff' ? `${item.path} (${item.commit ? `commit ${item.commit.slice(0, 7)}` : item.staged ? 'preparado' : 'alterações'})` : item.path"
              data-test="files-tab"
              @click="activate(item.key)"
              @auxclick.middle.prevent="closeTab(item.key)"
            >
              <img v-if="iconSet" :src="iconSet.fileIcon(item.path)" alt="" class="h-3.5 w-3.5 shrink-0" />
              <span class="max-w-40 truncate" :class="{ italic: item.kind === 'diff' }">{{ nameOf(item.path) }}</span>
              <span v-if="item.kind === 'diff'" class="mk-dim text-[10px]">{{ item.commit ? item.commit.slice(0, 7) : item.staged ? 'prep.' : 'diff' }}</span>
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
    <!-- O menu do botão direito na árvore. -->
    <div v-if="menu" class="fixed inset-0 z-50" @click="closeMenu" @contextmenu.prevent="closeMenu">
      <div class="mk-menu absolute min-w-40 rounded-md py-1 text-xs shadow-xl" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" role="menu" data-test="files-menu" @click.stop>
        <button type="button" role="menuitem" class="mk-hover flex w-full justify-between gap-4 px-3 py-1.5 text-left" data-test="files-menu-cut" @click="cut(menu.path)">
          Recortar
          <span class="mk-dim">⌘X</span>
        </button>
        <button type="button" role="menuitem" class="mk-hover flex w-full justify-between gap-4 px-3 py-1.5 text-left" data-test="files-menu-copy" @click="copy(menu.path)">
          Copiar
          <span class="mk-dim">⌘C</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="mk-hover flex w-full justify-between gap-4 px-3 py-1.5 text-left"
          :disabled="!clipboard"
          :class="{ 'opacity-40': !clipboard }"
          data-test="files-menu-paste"
          @click="paste(menu)"
        >
          Colar
          <span class="mk-dim">⌘V</span>
        </button>
        <div class="mk-border my-1 border-t" />
        <button type="button" role="menuitem" class="mk-hover block w-full px-3 py-1.5 text-left" data-test="files-menu-rename" @click="startRename(menu.path)">Renomear…</button>
        <button
          type="button"
          role="menuitem"
          class="mk-hover mk-deleted block w-full px-3 py-1.5 text-left"
          data-test="files-menu-delete"
          @click="removeFile(menu.path, menu.folder)"
        >
          Excluir
        </button>
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
      <span
        v-if="view === 'file' && opened && (problems.errors || problems.warnings)"
        class="shrink-0"
        :title="`ESLint: ${problems.errors} erro(s), ${problems.warnings} aviso(s)`"
        data-test="files-problems"
      >
        <span class="mk-deleted">⊗ {{ problems.errors }}</span>
        <span class="mk-orange">⚠ {{ problems.warnings }}</span>
      </span>
      <span v-else-if="view === 'file' && opened && lintNote" class="mk-dim min-w-0 truncate" :title="lintNote" data-test="files-lint-note">ESLint: {{ lintNote }}</span>
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
