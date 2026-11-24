<script setup lang="ts">
  import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
  import type { editor as MonacoEditor } from 'monaco-editor'
  import { api } from '@/lib/api'
  import { bytes, shortTime } from '@/lib/format'
  import { downloadUrl, fetchFileBlob, kindLabel, languageOf, TEXT_VIEW_MAX_BYTES, viewable, viewerOf, type IDeliveredFile } from '@/lib/fileViewer'
  import Icon from './Icon.vue'

  /**
   * 📎 Os ARQUIVOS DA CONVERSA: o que o agente entregou (`deliver_file` e afins), em lista, com o visualizador ao lado.
   * ⛔ Ver sem executar (ver `fileViewer.ts`): imagem como `<img>`, PDF no pdf.js, texto no Monaco somente leitura, HTML
   * como código e a prévia só no clique, num `iframe` com `sandbox=""`.
   */
  const props = defineProps<{ conversationId: string; selected?: string; refreshKey?: number }>()
  const emit = defineEmits<{ count: [number] }>()

  const PdfViewer = defineAsyncComponent(() => import('./PdfViewer.vue'))

  const files = ref<IDeliveredFile[]>([])
  const loading = ref(false)
  const failure = ref<string>()
  const activeId = ref<string>()
  const active = computed(() => files.value.find((file) => file.id === activeId.value))
  const viewer = computed(() => (active.value ? viewerOf(active.value) : 'none'))
  const tooBig = computed(() => !!active.value && (viewer.value === 'code' || viewer.value === 'html') && active.value.size > TEXT_VIEW_MAX_BYTES)

  let wanted = props.selected
  async function load() {
    loading.value = true
    failure.value = undefined
    try {
      files.value = await api<IDeliveredFile[]>(`/conversations/${encodeURIComponent(props.conversationId)}/files`)
      emit('count', files.value.length)
      // O pedido do chip vale uma vez; sem ele, fica o que estava aberto, ou o último entregue.
      if (wanted && files.value.some((file) => file.id === wanted)) activeId.value = wanted
      else if (!active.value) activeId.value = files.value.at(-1)?.id
      wanted = undefined
    } catch (error) {
      failure.value = error instanceof Error ? error.message : 'Não deu para listar os arquivos.'
    } finally {
      loading.value = false
    }
  }
  watch(() => [props.conversationId, props.refreshKey], load, { immediate: true })
  watch(
    () => props.selected,
    (id) => {
      if (!id) return
      if (files.value.some((file) => file.id === id)) activeId.value = id
      else {
        // Entregue depois da última leitura (o painel já estava aberto): relê e abre.
        wanted = id
        void load()
      }
    },
  )

  // O conteúdo do arquivo escolhido: blob (imagem), bytes (PDF) ou texto (código/HTML).
  const imageUrl = ref<string>()
  const pdfData = ref<ArrayBuffer>()
  const text = ref<string>()
  const opening = ref(false)
  const openFailure = ref<string>()
  const previewing = ref(false)
  let abort: AbortController | undefined

  function release() {
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
    imageUrl.value = undefined
    pdfData.value = undefined
    text.value = undefined
    previewing.value = false
  }

  const IMAGE_TYPE: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

  async function open(file: IDeliveredFile | undefined) {
    abort?.abort()
    release()
    openFailure.value = undefined
    if (!file || !viewable(file)) return
    abort = new AbortController()
    opening.value = true
    try {
      const blob = await fetchFileBlob(props.conversationId, file.id, abort.signal)
      const kind = viewerOf(file)
      if (kind === 'image') {
        // O tipo pela extensão: um SVG com tipo errado não desenha; como `<img>`, nunca roda script.
        const type = IMAGE_TYPE[file.name.toLowerCase().split('.').pop() ?? ''] ?? blob.type
        imageUrl.value = URL.createObjectURL(new Blob([blob], { type }))
      } else if (kind === 'pdf') pdfData.value = await blob.arrayBuffer()
      else {
        text.value = await blob.text()
        await nextTick()
        await showText(file)
      }
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') openFailure.value = error instanceof Error ? error.message : 'Não deu para abrir o arquivo.'
    } finally {
      opening.value = false
    }
  }
  watch(active, (file, before) => {
    if (file?.id !== before?.id) void open(file)
  })

  // O Monaco somente leitura: um editor, um modelo por vez.
  const host = ref<HTMLElement>()
  let editor: MonacoEditor.IStandaloneCodeEditor | undefined
  let model: MonacoEditor.ITextModel | undefined
  async function showText(file: IDeliveredFile) {
    if (text.value === undefined || !host.value) return
    const { monaco } = await import('@/lib/monaco')
    // O editor ficou num nó que saiu da tela (abriu um tipo que só baixa no meio): recria no de agora.
    if (editor && editor.getContainerDomNode() !== host.value) {
      editor.dispose()
      editor = undefined
    }
    editor ??= monaco.editor.create(host.value, {
      theme: 'monokai',
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      wordWrap: 'on',
      fontSize: 12,
    })
    model?.dispose()
    model = monaco.editor.createModel(text.value, languageOf(file.name))
    editor.setModel(model)
  }
  onBeforeUnmount(() => {
    abort?.abort()
    release()
    model?.dispose()
    editor?.dispose()
  })

  /** ⛔ A prévia do HTML: `sandbox=""` (sem script, sem a origem do gateway, sem formulário nem popup), via `srcdoc`. */
  function togglePreview() {
    previewing.value = !previewing.value
  }
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-200" data-test="conversation-files">
    <div class="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-2">
      <span class="text-xs text-zinc-400">{{ files.length === 1 ? '1 arquivo entregue' : `${files.length} arquivos entregues` }}</span>
      <button type="button" class="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-800" title="Atualizar" data-test="conversation-files-refresh" @click="load">
        <Icon name="refresh" class="h-4 w-4" />
      </button>
    </div>
    <p v-if="failure" class="p-3 text-sm text-rose-300">{{ failure }}</p>
    <p v-else-if="!loading && !files.length" class="p-3 text-sm text-zinc-500">Nenhum arquivo entregue nesta conversa.</p>
    <ul v-else class="max-h-[40%] shrink-0 overflow-y-auto border-b border-zinc-800 text-xs" data-test="conversation-files-list">
      <li
        v-for="file in files"
        :key="file.id"
        class="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-zinc-900"
        :class="{ 'bg-zinc-900 ring-1 ring-emerald-700 ring-inset': file.id === activeId }"
        :data-test="`conversation-file-${file.id}`"
        @click="activeId = file.id"
      >
        <Icon :name="viewable(file) ? 'eye' : 'doc'" class="h-3.5 w-3.5 shrink-0" :class="viewable(file) ? 'text-emerald-400' : 'text-zinc-500'" />
        <span class="min-w-0 flex-1 truncate" :title="file.name">{{ file.name }}</span>
        <span class="shrink-0 text-zinc-500">{{ kindLabel(file) }}</span>
        <span class="w-14 shrink-0 text-right text-zinc-500">{{ bytes(file.size) }}</span>
        <span class="w-14 shrink-0 text-right text-zinc-500">{{ file.turn !== undefined ? `turno ${file.turn + 1}` : '' }}</span>
        <span class="w-16 shrink-0 text-right text-zinc-500" :title="new Date(file.createdAt).toLocaleString('pt-BR')">{{ shortTime(file.createdAt) }}</span>
        <a
          :href="downloadUrl(conversationId, file.id)"
          :download="file.name"
          class="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          :title="`Baixar ${file.name}`"
          @click.stop
        >
          <Icon name="download" class="h-3.5 w-3.5" />
        </a>
      </li>
    </ul>

    <div v-if="active" class="relative flex min-h-0 flex-1 flex-col" data-test="conversation-file-viewer" :data-viewer="viewer">
      <div class="flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs text-zinc-400">
        <span class="min-w-0 truncate text-zinc-200">{{ active.name }}</span>
        <button
          v-if="viewer === 'html' && !tooBig"
          type="button"
          class="ml-auto rounded px-2 py-0.5 ring-1 ring-zinc-700 hover:bg-zinc-800"
          data-test="html-preview-toggle"
          @click="togglePreview"
        >
          {{ previewing ? 'Ver código' : 'Pré-visualizar' }}
        </button>
      </div>
      <p v-if="openFailure" class="p-3 text-sm text-rose-300">{{ openFailure }}</p>
      <div v-else-if="viewer === 'none' || tooBig" class="p-4 text-sm text-zinc-400" data-test="download-only">
        {{ tooBig ? 'Grande demais para ver aqui.' : 'Este tipo não abre no gateway.' }}
        <a :href="downloadUrl(conversationId, active.id)" :download="active.name" class="text-emerald-400 hover:underline">Baixar</a>
      </div>
      <template v-else>
        <p v-if="opening" class="p-3 text-xs text-zinc-500">Abrindo…</p>
        <div v-if="viewer === 'image' && imageUrl" class="min-h-0 flex-1 overflow-auto p-3">
          <img
            :src="imageUrl"
            :alt="active.name"
            class="mx-auto max-w-full bg-[repeating-conic-gradient(#27272a_0_25%,#18181b_0_50%)] bg-[length:16px_16px]"
            data-test="image-viewer"
          />
        </div>
        <PdfViewer v-else-if="viewer === 'pdf' && pdfData" :data="pdfData" class="min-h-0 flex-1" />
        <iframe
          v-if="viewer === 'html' && previewing && text !== undefined"
          sandbox=""
          :srcdoc="text"
          referrerpolicy="no-referrer"
          title="Prévia do HTML (sem script)"
          class="min-h-0 flex-1 bg-white"
          data-test="html-preview"
        />
        <div v-show="(viewer === 'code' || viewer === 'html') && !previewing" class="relative min-h-0 flex-1">
          <div ref="host" class="absolute inset-0" data-test="code-viewer" />
        </div>
      </template>
    </div>
  </div>
</template>
