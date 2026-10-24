<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { IOutgoingFile } from '@/stores/thread'
import Icon from './Icon.vue'

const props = defineProps<{ sending: boolean; disabled?: boolean; placeholder?: string }>()
/** `settle(false)`: o envio falhou — o texto e os anexos voltam para a caixa. */
const emit = defineEmits<{ send: [text: string, files: IOutgoingFile[], settle: (ok: boolean) => void]; stop: [] }>()

const text = ref('')
const files = ref<IOutgoingFile[]>([])
const area = ref<HTMLTextAreaElement>()
const picker = ref<HTMLInputElement>()

/**
 * No celular o texto de exemplo vira só "Mensagem": "Mensagem para <agente>" quebrava em duas linhas e
 * dobrava a altura da caixa vazia. O agente já está no cabeçalho.
 */
const narrowQuery = typeof window !== 'undefined' ? window.matchMedia('(max-width: 767px)') : undefined
const narrow = ref(narrowQuery?.matches ?? false)
const onNarrow = (event: MediaQueryListEvent) => (narrow.value = event.matches)
narrowQuery?.addEventListener('change', onNarrow)
onBeforeUnmount(() => narrowQuery?.removeEventListener('change', onNarrow))
const shownPlaceholder = computed(() => (narrow.value || !props.placeholder ? 'Mensagem' : props.placeholder))

/** O conteúdo vai em base64 (`files[].data`), como a API espera. */
async function attach(event: Event) {
  const input = event.target as HTMLInputElement
  for (const file of Array.from(input.files ?? [])) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    files.value.push({ name: file.name, mimeType: file.type || 'application/octet-stream', data })
  }
  input.value = ''
}

function grow() {
  const element = area.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 200)}px`
}

function submit() {
  if (props.sending || props.disabled) return
  const message = text.value.trim()
  if (!message && !files.value.length) return
  const sentFiles = files.value
  // ⚠️ Limpa na hora (a resposta chega em streaming), mas devolve se o envio falhar: o texto digitado não se perde.
  // Se já digitou outra coisa por cima, não sobrescreve.
  const settle = (ok: boolean) => {
    if (ok || text.value || files.value.length) return
    text.value = message
    files.value = sentFiles
    void nextTick(grow)
  }
  emit('send', message, sentFiles, settle)
  text.value = ''
  files.value = []
  void nextTick(grow)
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}
</script>

<template>
  <form class="border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-3" @submit.prevent="submit">
    <div v-if="files.length" class="mb-2 flex flex-wrap gap-1.5">
      <span v-for="(file, index) in files" :key="index" class="flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-xs">
        {{ file.name }}
        <button type="button" class="text-zinc-400 hover:text-white" @click="files.splice(index, 1)"><Icon name="x" class="h-3.5 w-3.5" /></button>
      </span>
    </div>
    <div class="flex items-end gap-2">
      <button type="button" class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40" :disabled="disabled" title="Anexar" @click="picker?.click()">
        <Icon name="clip" class="h-5 w-5" />
      </button>
      <input ref="picker" type="file" multiple class="hidden" @change="attach" />
      <textarea
        ref="area"
        v-model="text"
        rows="1"
        :disabled="disabled"
        :placeholder="shownPlaceholder"
        class="scroll-thin max-h-[200px] min-h-10 flex-1 resize-none rounded-2xl bg-zinc-800 px-4 py-2.5 text-[15px] outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-emerald-500/60 disabled:opacity-50"
        @input="grow"
        @keydown="onKey"
      />
      <button v-if="sending" type="button" class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-500 text-white hover:bg-rose-400" title="Parar" @click="emit('stop')">
        <Icon name="stop" class="h-5 w-5" />
      </button>
      <button v-else type="submit" class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" :disabled="disabled" title="Enviar">
        <Icon name="send" class="h-5 w-5" />
      </button>
    </div>
  </form>
</template>
