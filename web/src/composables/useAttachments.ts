import { ref } from 'vue'
import type { IOutgoingFile } from '@/stores/thread'

/**
 * 📎 ANEXAR: o clipe, colar (um print, uma imagem copiada) e arrastar para cima da caixa. O conteúdo vai em base64
 * (`files[].data`), como a API espera. O mesmo na caixa da conversa (`Composer`) e na resposta pelas Mensagens.
 * `disabled`: com a caixa desligada, colar e arrastar não anexam.
 */
export function useAttachments(disabled: () => boolean = () => false) {
  const files = ref<IOutgoingFile[]>([])
  /** O arquivo está por cima da caixa: a borda acende. */
  const dragging = ref(false)

  async function addFiles(list: File[]) {
    for (const file of list) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      files.value.push({ name: pastedName(file), mimeType: file.type || 'application/octet-stream', data })
    }
  }

  /** O print colado chega sempre como `image.png`: dois seguidos teriam o mesmo nome. */
  function pastedName(file: File): string {
    if (file.name && file.name !== 'image.png') return file.name
    const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    return `imagem-${new Date().toISOString().slice(11, 19).replaceAll(':', '')}-${files.value.length + 1}.${extension}`
  }

  /** O `<input type="file">` do clipe. */
  async function attach(event: Event) {
    const input = event.target as HTMLInputElement
    await addFiles(Array.from(input.files ?? []))
    input.value = ''
  }

  /** Colar com arquivo anexa; colar só texto segue como sempre. */
  function onPaste(event: ClipboardEvent) {
    const pasted = Array.from(event.clipboardData?.files ?? [])
    if (disabled() || !pasted.length) return
    event.preventDefault()
    void addFiles(pasted)
  }

  const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')
  function onDragOver(event: DragEvent) {
    if (disabled() || !carriesFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    dragging.value = true
  }
  function onDragLeave(event: DragEvent) {
    const form = event.currentTarget as HTMLElement
    if (!form.contains(event.relatedTarget as Node | null)) dragging.value = false
  }
  function onDrop(event: DragEvent) {
    dragging.value = false
    if (disabled() || !carriesFiles(event)) return
    event.preventDefault()
    void addFiles(Array.from(event.dataTransfer?.files ?? []))
  }

  return { files, dragging, addFiles, attach, onPaste, onDragOver, onDragLeave, onDrop }
}
