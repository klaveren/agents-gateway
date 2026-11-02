<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api, ApiError } from '@/lib/api'
import { bytesOf, fileIssue, type IResourceFile, toBase64 } from '@/lib/resourceFiles'

/**
 * A GUIA ARQUIVOS de uma skill, command ou agente: os scripts e modelos que vão na pasta dele (só leitura para o agente).
 * Enviar, criar, editar texto, renomear e remover mexem num rascunho; "Salvar arquivos" grava a lista inteira (`save`).
 * ⛔ Só texto, até 1 MB, e nada com segredo: o servidor recusa no envio, com o motivo.
 */
const props = defineProps<{
  files: readonly IResourceFile[]
  /** Grava a lista (a rota `…/files` do dono). */
  save: (files: IResourceFile[]) => Promise<void>
  /** Onde a pasta mora, para a pessoa saber (ex.: `global/skills/banco`). */
  where: string
}>()

const draft = ref<IResourceFile[]>([])
const folder = ref('scripts')
const busy = ref(false)
const error = ref<string>()
const note = ref<string>()
/** O arquivo aberto no editor: o caminho e o texto (novo ou carregado do depósito). */
const editing = ref<{ index?: number; path: string; text: string }>()

watch(
  () => props.files,
  (files) => (draft.value = files.map((file) => ({ ...file }))),
  { immediate: true },
)

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.files))
const total = computed(() => draft.value.reduce((sum, file) => sum + file.bytes, 0))
const issues = computed(() => draft.value.map((file, index) => fileIssue(file.path, draft.value, index)))

function message(failure: unknown): string {
  if (failure instanceof ApiError && Array.isArray(failure.details)) {
    const details = (failure.details as Array<{ message?: string }>).map((item) => item.message).filter(Boolean)
    if (details.length) return details.join('; ')
  }
  return failure instanceof Error ? failure.message : String(failure)
}

async function upload(content: Uint8Array): Promise<{ sha256: string; bytes: number }> {
  return api<{ sha256: string; bytes: number }>('/files', { method: 'POST', body: { content: toBase64(content) } })
}

/** Põe na lista (troca o de mesmo caminho). */
function put(file: IResourceFile, index?: number) {
  const at = index ?? draft.value.findIndex((item) => item.path === file.path)
  if (at >= 0) draft.value.splice(at, 1, file)
  else draft.value.push(file)
}

async function pick(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = [...(input.files ?? [])]
  input.value = ''
  if (!chosen.length) return
  busy.value = true
  error.value = undefined
  note.value = undefined
  try {
    const prefix = folder.value.trim().replace(/^\/+|\/+$/g, '')
    for (const file of chosen) {
      const stored = await upload(new Uint8Array(await file.arrayBuffer()))
      put({ path: prefix ? `${prefix}/${file.name}` : file.name, ...stored })
    }
    note.value = `${chosen.length} arquivo(s) enviado(s). Salve para gravar na pasta.`
  } catch (failure) {
    error.value = message(failure)
  } finally {
    busy.value = false
  }
}

async function edit(index: number) {
  busy.value = true
  error.value = undefined
  try {
    const file = draft.value[index]
    const stored = await api<{ text: string }>(`/files/${file.sha256}`)
    editing.value = { index, path: file.path, text: stored.text }
  } catch (failure) {
    error.value = message(failure)
  } finally {
    busy.value = false
  }
}

function create() {
  const prefix = folder.value.trim().replace(/^\/+|\/+$/g, '')
  editing.value = { path: prefix ? `${prefix}/novo.sh` : 'novo.sh', text: '' }
}

async function keep() {
  if (!editing.value) return
  const { index, path, text } = editing.value
  const pathIssue = fileIssue(path.trim(), draft.value, index)
  if (pathIssue) return void (error.value = pathIssue)
  busy.value = true
  error.value = undefined
  try {
    const stored = await upload(bytesOf(text))
    put({ path: path.trim(), ...stored }, index)
    editing.value = undefined
  } catch (failure) {
    error.value = message(failure)
  } finally {
    busy.value = false
  }
}

function remove(index: number) {
  draft.value.splice(index, 1)
}

async function saveAll() {
  if (issues.value.some(Boolean)) return
  busy.value = true
  error.value = undefined
  note.value = undefined
  try {
    await props.save(draft.value.map((file) => ({ ...file })))
    note.value = 'Arquivos gravados na pasta.'
  } catch (failure) {
    error.value = message(failure)
  } finally {
    busy.value = false
  }
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)
</script>

<template>
  <section class="flex flex-col gap-3" data-test="resource-files">
    <p class="text-sm text-zinc-400">
      Scripts, modelos e dados que vão na pasta <code class="text-zinc-300">{{ where }}</code>. O agente lê e roda pelo terminal, mas não grava nela: mudança é só por aqui. Só
      texto, até 1 MB por arquivo; credencial fica numa variável do gateway, nunca no arquivo.
    </p>

    <div class="flex flex-wrap items-end gap-2">
      <label class="field w-40">
        Pasta
        <input v-model="folder" class="input" placeholder="scripts" data-test="files-folder" />
      </label>
      <label class="btn btn-secondary btn-sm mb-0.5 cursor-pointer" :class="busy ? 'pointer-events-none opacity-50' : ''">
        Enviar arquivos
        <input type="file" multiple class="hidden" data-test="files-upload" @change="pick" />
      </label>
      <button type="button" class="btn btn-secondary btn-sm mb-0.5" :disabled="busy" data-test="files-new" @click="create">Novo arquivo</button>
    </div>

    <p v-if="!draft.length" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Nenhum arquivo.</p>
    <ul v-else class="divide-y divide-zinc-800 rounded-xl border border-zinc-800 text-sm" data-test="files-list">
      <li v-for="(file, index) in draft" :key="index" class="flex flex-wrap items-center gap-2 px-3 py-2" data-test="file-row">
        <input v-model="file.path" class="input min-w-0 flex-1 font-mono text-xs" :aria-label="`Caminho de ${file.path}`" data-test="file-path" />
        <span class="text-xs text-zinc-500 tabular-nums">{{ size(file.bytes) }}</span>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" data-test="file-edit" @click="edit(index)">Editar</button>
        <button type="button" class="btn btn-ghost btn-sm text-rose-300" :disabled="busy" data-test="file-remove" @click="remove(index)">Remover</button>
        <small v-if="issues[index]" class="basis-full text-xs text-rose-300" data-test="file-issue">{{ issues[index] }}</small>
      </li>
    </ul>

    <form v-if="editing" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3" data-test="file-editor" @submit.prevent="keep">
      <label class="field">
        Caminho
        <input v-model="editing.path" class="input font-mono text-xs" data-test="editor-path" />
      </label>
      <textarea v-model="editing.text" class="input min-h-64 font-mono text-xs" spellcheck="false" data-test="editor-text" />
      <div class="flex gap-2">
        <button type="submit" class="btn btn-secondary btn-sm" :disabled="busy" data-test="editor-keep">Guardar no rascunho</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="editing = undefined">Cancelar</button>
      </div>
    </form>

    <p v-if="error" class="text-sm text-rose-300" data-test="files-error">{{ error }}</p>
    <p v-if="note" class="text-sm text-emerald-300" data-test="files-note">{{ note }}</p>
    <div class="flex items-center gap-3">
      <button type="button" class="btn btn-primary" :disabled="busy || !dirty || issues.some(Boolean)" data-test="files-save" @click="saveAll">Salvar arquivos</button>
      <span class="text-xs text-zinc-500">{{ draft.length }} arquivo(s) · {{ size(total) }}<template v-if="dirty"> · não salvo</template></span>
    </div>
  </section>
</template>
