<script setup lang="ts">
  import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
  import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

  /**
   * 📄 O PDF entregue, pelo pdf.js, desenhado em canvas: uma página por vez, com página e zoom.
   *
   * ⛔ Nada do PDF roda: sem a camada de anotações nem de formulários (`AnnotationMode.DISABLE`), sem XFA, sem o
   * "scripting" do visualizador (que só existe no viewer completo, não aqui). O pdf.js 6 não tem mais o caminho de `eval`
   * das fontes (a opção `isEvalSupported` saiu da API). O worker é o do pacote, empacotado pelo Vite na mesma origem.
   */
  const props = defineProps<{ data: ArrayBuffer }>()

  const canvas = ref<HTMLCanvasElement>()
  const doc = shallowRef<PDFDocumentProxy>()
  const page = ref(1)
  const pages = ref(0)
  const zoom = ref(1)
  const failure = ref<string>()
  let task: RenderTask | undefined
  let loading: PDFDocumentLoadingTask | undefined
  let pdfjs: typeof import('pdfjs-dist') | undefined

  async function load() {
    failure.value = undefined
    task?.cancel()
    await loading?.destroy()
    doc.value = undefined
    try {
      if (!pdfjs) {
        pdfjs = await import('pdfjs-dist')
        const { default: PdfWorker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker')
        pdfjs.GlobalWorkerOptions.workerPort ??= new PdfWorker()
      }
      // A cópia: o pdf.js transfere o buffer ao worker, e o original continua de quem chamou.
      loading = pdfjs.getDocument({ data: new Uint8Array(props.data.slice(0)), enableXfa: false, useWasm: false })
      doc.value = await loading.promise
      pages.value = doc.value.numPages
      page.value = 1
      await draw()
    } catch (error) {
      failure.value = error instanceof Error ? error.message : 'Não deu para abrir o PDF.'
    }
  }

  async function draw() {
    if (!doc.value || !canvas.value || !pdfjs) return
    task?.cancel()
    const current = await doc.value.getPage(page.value)
    const ratio = window.devicePixelRatio || 1
    const viewport = current.getViewport({ scale: zoom.value * ratio })
    canvas.value.width = Math.floor(viewport.width)
    canvas.value.height = Math.floor(viewport.height)
    canvas.value.style.width = `${Math.floor(viewport.width / ratio)}px`
    canvas.value.style.height = `${Math.floor(viewport.height / ratio)}px`
    task = current.render({ canvas: canvas.value, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE })
    try {
      await task.promise
    } catch (error) {
      if (!(error instanceof pdfjs.RenderingCancelledException)) failure.value = error instanceof Error ? error.message : String(error)
    }
  }

  const go = (to: number) => {
    page.value = Math.min(Math.max(1, to), pages.value || 1)
  }
  const scale = (by: number) => {
    zoom.value = Math.min(4, Math.max(0.25, Math.round((zoom.value + by) * 100) / 100))
  }

  watch(() => props.data, load, { immediate: true })
  watch([page, zoom], () => void draw())
  onBeforeUnmount(() => {
    task?.cancel()
    void loading?.destroy()
  })
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" data-test="pdf-viewer">
    <div class="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-300">
      <button type="button" class="rounded px-1.5 py-0.5 hover:bg-zinc-800 disabled:opacity-40" :disabled="page <= 1" title="Página anterior" @click="go(page - 1)">‹</button>
      <span data-test="pdf-page">{{ page }} / {{ pages || '…' }}</span>
      <button type="button" class="rounded px-1.5 py-0.5 hover:bg-zinc-800 disabled:opacity-40" :disabled="page >= pages" title="Próxima página" @click="go(page + 1)">›</button>
      <span class="ml-auto" />
      <button type="button" class="rounded px-1.5 py-0.5 hover:bg-zinc-800" title="Diminuir" @click="scale(-0.25)">−</button>
      <span class="w-10 text-center">{{ Math.round(zoom * 100) }}%</span>
      <button type="button" class="rounded px-1.5 py-0.5 hover:bg-zinc-800" title="Aumentar" @click="scale(0.25)">+</button>
    </div>
    <p v-if="failure" class="p-4 text-sm text-rose-300">Não deu para abrir o PDF: {{ failure }}</p>
    <div v-else class="min-h-0 flex-1 overflow-auto bg-zinc-950 p-3">
      <canvas ref="canvas" class="mx-auto block bg-white shadow" />
    </div>
  </div>
</template>
