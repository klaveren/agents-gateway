<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { IOutgoingFile } from '@/stores/thread'
import { commandSuggestions, type ICommandHint } from '@/lib/commands'
import Icon from './Icon.vue'

const props = defineProps<{ sending: boolean; disabled?: boolean; placeholder?: string; commands?: ICommandHint[] }>()
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

/**
 * A busca de `/`: commands e skills, pelo nome e pela descrição, enquanto a mensagem começa com `/` e o nome ainda
 * está sendo digitado. Setas escolhem, Enter ou Tab completam (`/nome `, para o pedido), Esc fecha até o texto mudar.
 * A skill escolhida vai inteira para o agente, já carregada.
 */
const dismissed = ref<string>()
const highlighted = ref(0)
const suggestions = computed(() => (dismissed.value === text.value ? [] : commandSuggestions(text.value, props.commands ?? [])))
watch(suggestions, () => (highlighted.value = 0))
/** Digitou `/` e nada casa: diz por quê, em vez de a caixa ficar muda. */
const slashEmpty = computed(() => dismissed.value !== text.value && /^\/\S*$/.test(text.value) && !suggestions.value.length)

function complete(id: string) {
  text.value = `/${id} `
  void nextTick(() => {
    grow()
    area.value?.focus()
  })
}

function onKey(event: KeyboardEvent) {
  if (suggestions.value.length && !event.isComposing) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      highlighted.value = (highlighted.value + step + suggestions.value.length) % suggestions.value.length
      return
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault()
      complete(suggestions.value[highlighted.value].id)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissed.value = text.value
      return
    }
  }
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
    <p v-if="slashEmpty" class="mb-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
      {{ (commands ?? []).length ? 'Nenhum command ou skill com esse nome para este agente.' : 'Este agente não tem commands nem skills — ou a guia Recursos dele não libera nenhum.' }}
    </p>
    <ul v-if="suggestions.length" class="mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-lg shadow-black/30" role="listbox" aria-label="Commands e skills">
      <li v-for="(command, index) in suggestions" :key="command.id" role="option" :aria-selected="index === highlighted">
        <button
          type="button"
          class="flex w-full items-baseline gap-3 px-3 py-2 text-left"
          :class="index === highlighted ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'"
          @mousedown.prevent="complete(command.id)"
          @mouseenter="highlighted = index"
        >
          <code class="shrink-0 text-emerald-300">/{{ command.id }}</code>
          <span class="shrink-0 rounded-full px-1.5 text-[10px]" :class="command.kind === 'skill' ? 'bg-violet-500/15 text-violet-300' : 'bg-zinc-800 text-zinc-400'">{{ command.kind === 'skill' ? 'skill' : 'command' }}</span>
          <span class="min-w-0 truncate text-xs text-zinc-400">{{ command.description }}</span>
        </button>
      </li>
    </ul>
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
        class="scroll-thin max-h-[200px] min-h-10 flex-1 resize-none rounded-2xl bg-zinc-800 px-4 py-2.5 text-sm outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-emerald-500/60 disabled:opacity-50"
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
