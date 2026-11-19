<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useProjectsStore } from '@/stores/projects'

  /**
   * 📄 O MODELO DOS DOCUMENTOS DO PROJETO: o que o `render_document` põe no cabeçalho, no rodapé e na cor de destaque de todo
   * PDF, DOCX e PPTX que os agentes deste projeto geram. Vazio = o padrão (o nome do projeto no cabeçalho, verde).
   */
  const props = defineProps<{ projectId: string }>()
  const projects = useProjectsStore()
  const project = computed(() => projects.list.find((item) => item.id === props.projectId))

  const organization = ref('')
  const footer = ref('')
  const color = ref('')
  const busy = ref(false)
  const note = ref<string>()
  const error = ref<string>()

  watch(
    () => project.value?.documentTemplate,
    (template) => {
      organization.value = template?.organization ?? ''
      footer.value = template?.footer ?? ''
      color.value = template?.color ?? ''
    },
    { immediate: true },
  )

  const shown = computed(() => (/^#[0-9a-f]{6}$/i.test(color.value) ? color.value : '#10b981'))

  async function save() {
    busy.value = true
    note.value = undefined
    error.value = undefined
    try {
      await projects.setDocumentTemplate(props.projectId, { organization: organization.value, footer: footer.value, color: color.value })
      note.value = 'Modelo dos documentos salvo.'
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }
</script>

<template>
  <form class="flex flex-col gap-3" data-test="project-documents" @submit.prevent="save">
    <p class="text-xs text-zinc-500">
      O cabeçalho, o rodapé e a cor dos documentos que os agentes deste projeto geram (PDF, Word e apresentação). Para um agente gerar, ligue "Gerar documentos" no cadastro dele.
    </p>
    <label class="flex flex-col gap-1 text-xs font-medium text-zinc-400">
      Nome no cabeçalho
      <input v-model="organization" maxlength="120" class="h-9 rounded-lg bg-zinc-950 px-3 text-sm text-zinc-100 ring-1 ring-zinc-800" :placeholder="project?.name" />
    </label>
    <label class="flex flex-col gap-1 text-xs font-medium text-zinc-400">
      Rodapé
      <input v-model="footer" maxlength="300" class="h-9 rounded-lg bg-zinc-950 px-3 text-sm text-zinc-100 ring-1 ring-zinc-800" placeholder="CNPJ, endereço, site" />
    </label>
    <label class="flex items-center gap-2 text-xs font-medium text-zinc-400">
      Cor de destaque
      <input
        :value="shown"
        type="color"
        class="h-9 w-12 rounded-lg bg-zinc-950 ring-1 ring-zinc-800"
        aria-label="Cor de destaque"
        @input="color = ($event.target as HTMLInputElement).value"
      />
      <input v-model="color" maxlength="7" class="h-9 w-28 rounded-lg bg-zinc-950 px-3 font-mono text-sm text-zinc-100 ring-1 ring-zinc-800" placeholder="#10b981" />
    </label>
    <div class="rounded-xl border border-zinc-800 bg-white p-4 text-zinc-800" data-test="project-documents-preview">
      <div class="text-right text-[10px] text-zinc-500">{{ organization || project?.name }}</div>
      <div class="mt-2 text-lg font-bold" :style="{ color: shown }">Título do documento</div>
      <div class="mt-1 h-2 w-3/4 rounded bg-zinc-200" />
      <div class="mt-1 h-2 w-2/3 rounded bg-zinc-200" />
      <div class="mt-4 flex justify-between text-[10px] text-zinc-500">
        <span>{{ footer }}</span>
        <span>1 / 1</span>
      </div>
    </div>
    <button type="submit" class="btn btn-primary self-end" :disabled="busy" data-test="project-documents-save">{{ busy ? 'Salvando…' : 'Salvar modelo' }}</button>
    <p v-if="note" class="text-sm text-success-300">{{ note }}</p>
    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
  </form>
</template>
