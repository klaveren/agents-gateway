<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useResource } from '@/composables/useResource'
import { isServiceRule, serviceIssue, serviceOf, withServices, type IProjectService } from '@/lib/projectServices'
import { usePermissionsStore } from '@/stores/permissions'
import Icon from './Icon.vue'

/**
 * 🔌 Os SERVIÇOS do ambiente do projeto (Redis, Kafka, Mongo…): cada linha é a regra de rede exata `host:porta` do
 * projeto, com o nome na nota. Vale para todo agente do projeto; o agente que não deve chegar lá nega na guia dele.
 * Salvar relê as regras antes e troca só os serviços: o resto das Permissões fica como está.
 */
const props = defineProps<{ projectId: string; readOnly?: boolean }>()
const permissions = usePermissionsStore()
const stored = useResource(permissions.projects, () => props.projectId)
const saved = computed(() => (stored.data.value?.rules ?? []).filter(isServiceRule).map(serviceOf))

const rows = ref<IProjectService[]>([])
watch(saved, (list) => (rows.value = list.map((service) => ({ ...service }))), { immediate: true })

const issues = computed(() => rows.value.map(serviceIssue))
const dirty = computed(() => JSON.stringify(rows.value.filter((row) => row.host.trim() || row.port.trim())) !== JSON.stringify(saved.value))
const busy = ref(false)
const error = ref<string>()
const note = ref<string>()

function add(): void {
  rows.value = [...rows.value, { name: '', host: '', port: '' }]
}

function remove(index: number): void {
  rows.value = rows.value.filter((_, at) => at !== index)
}

async function save(): Promise<void> {
  busy.value = true
  error.value = undefined
  note.value = undefined
  // ⚠️ As linhas antes de reler: a releitura muda o gravado, e o `watch` repõe as linhas com ele.
  const services = rows.value.map((row) => ({ ...row }))
  try {
    const fresh = await permissions.projects.refresh(props.projectId)
    await permissions.save(props.projectId, withServices(fresh.rules, services))
    note.value = 'Serviços salvos. Valem no próximo comando dos agentes.'
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3" data-test="project-services">
    <p class="text-xs text-zinc-500">
      Os bancos e filas que o projeto usa. Cada linha abre só aquele host e porta para todos os agentes do projeto. Para um agente não chegar lá, negue na
      guia Permissões dele.
    </p>
    <p v-if="stored.loading.value" class="text-sm text-zinc-500">Carregando…</p>
    <p v-else-if="!rows.length" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Nenhum serviço ainda.</p>
    <fieldset :disabled="readOnly || busy" class="contents">
      <ul v-if="rows.length" class="flex flex-col gap-2">
        <li v-for="(row, index) in rows" :key="index" class="flex flex-col gap-1" data-test="service-row">
          <div class="flex flex-wrap items-center gap-2">
            <input v-model="row.name" class="input w-36" placeholder="Redis" aria-label="Nome do serviço" />
            <input v-model="row.host" class="input min-w-0 flex-1 font-mono" placeholder="10.10.0.3" aria-label="Host" />
            <input v-model="row.port" class="input w-24 font-mono" inputmode="numeric" placeholder="6379" aria-label="Porta" />
            <button type="button" class="grid h-9 w-9 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-rose-300" title="Tirar o serviço" @click="remove(index)">
              <Icon name="trash" class="h-4 w-4" />
            </button>
          </div>
          <small v-if="issues[index]" class="text-xs text-rose-300">{{ issues[index] }}</small>
        </li>
      </ul>
      <div v-if="!readOnly" class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-ghost" data-test="service-add" @click="add">+ Serviço</button>
        <button type="button" class="btn btn-primary ml-auto" data-test="service-save" :disabled="!dirty || issues.some(Boolean) || busy" @click="save">
          {{ busy ? 'Salvando…' : 'Salvar serviços' }}
        </button>
      </div>
    </fieldset>
    <p v-if="note" class="text-sm text-success-300">{{ note }}</p>
    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
  </div>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
