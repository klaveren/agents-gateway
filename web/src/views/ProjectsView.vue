<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ProjectSettings from '@/components/ProjectSettings.vue'
import { useConnectionsStore } from '@/stores/connections'
import Icon from '@/components/Icon.vue'
import ListFilter from '@/components/ListFilter.vue'
import { countLabel, filterList, sortByName } from '@/lib/listFilter'
import MasterDetail from '@/components/MasterDetail.vue'
import { ApiError } from '@/lib/api'
import { initials } from '@/lib/format'
import { PALETTES, projectGradient } from '@/lib/projectColors'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * Sistema → Projetos: a lista de todos os projetos que a pessoa administra, criar e conectar (admin do gateway) e, ao
 * abrir um, a mesma configuração de Projeto → Configurações (`ProjectSettings`), com usar e apagar.
 */
const props = defineProps<{ id?: string }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
/** A busca do topo da lista. */
const query = ref('')
const shownProjects = computed(() =>
  sortByName(
    filterList(projects.list, { query: query.value }, (project) => [project.id, project.name, project.description]),
    (project) => project.name,
  ),
)

const adding = computed(() => route.name === 'project-new')
const selected = computed(() => (props.id ? projects.list.find((project) => project.id === props.id) : undefined))
/** Abre a guia: o admin do gateway, ou quem administra algum projeto. */
const canOpen = computed(() => auth.isAdmin || projects.managesAny)

const connections = useConnectionsStore()
/** Criar do zero, ou conectar um projeto de outro gateway (a .4): o catálogo vem de lá, só leitura. */
const mode = ref<'new' | 'connect'>('new')
const link = ref({ url: '', projectId: '', token: '' })
const connecting = ref(false)

const loadError = ref<string>()
const form = ref({ id: '', name: '', description: '' })
const formIssues = ref<Record<string, string[]>>({})
const formError = ref<string>()

onMounted(async () => {
  await projects.ensure().catch((failure) => (loadError.value = describe(failure)))
})

function describe(failure: unknown): string {
  if (failure instanceof ApiError && failure.status === 422) {
    const items = Array.isArray(failure.details) ? (failure.details as Array<{ field?: string; message?: string }>) : []
    return items.map((item) => (item.field ? `${item.field}: ${item.message}` : item.message)).join('; ') || failure.message
  }
  return failure instanceof Error ? failure.message : String(failure)
}

function slug() {
  if (form.value.id) return
  form.value.id = form.value.name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
}

async function create() {
  formIssues.value = {}
  formError.value = undefined
  try {
    const created = await projects.create({ id: form.value.id, name: form.value.name, description: form.value.description || undefined })
    form.value = { id: '', name: '', description: '' }
    await router.push(`/projects/${created.id}`)
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) formIssues.value = failure.fieldIssues
    formError.value = describe(failure)
  }
}

async function connectProject() {
  formError.value = undefined
  connecting.value = true
  try {
    const created = await connections.connect({ url: link.value.url, projectId: link.value.projectId, token: link.value.token })
    link.value = { url: '', projectId: '', token: '' }
    await projects.load()
    await router.push(`/projects/${created.projectId}`)
  } catch (failure) {
    formError.value = describe(failure)
  } finally {
    connecting.value = false
  }
}
</script>

<template>
  <div v-if="!canOpen" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra um projeto cuida dos projetos.</p>
  </div>

  <MasterDetail v-else :open="!!id || adding" back-to="/projects" back-label="Projetos" :title="adding ? 'Novo projeto' : selected?.name">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-1">
        <h1 class="text-xl font-semibold">Projetos</h1>
        <span class="text-sm text-zinc-500" data-test="list-count">{{ countLabel(shownProjects.length, projects.list.length) }}</span>
        <RouterLink v-if="auth.isAdmin" to="/projects/new" class="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Novo projeto"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <p class="px-4 pb-3 text-xs text-zinc-500">Cada projeto tem seus agentes, conversas e pasta.</p>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <ListFilter v-model:query="query" placeholder="Buscar projeto…" />
      <p v-if="!projects.list.length && !loadError" class="px-4 py-2 text-sm text-zinc-500">Nenhum projeto ainda.</p>
      <RouterLink
        v-for="project in shownProjects"
        :key="project.id"
        :to="`/projects/${project.id}`"
        class="mx-2 flex items-center gap-3 rounded-xl px-3 py-2"
        :class="project.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'"
      >
        <span :style="projectGradient(project.color, 0.3) ? { background: projectGradient(project.color, 0.3), color: PALETTES[project.color as keyof typeof PALETTES]['200'] } : undefined" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-emerald-400/30 to-accent-end/30 text-xs font-semibold text-emerald-200">{{ initials(project.name) }}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ project.name }}</span>
          <span class="block truncate text-xs text-zinc-500">{{ project.id }} · {{ project.members ?? 0 }} membro(s)</span>
        </span>
        <span v-if="project.color" class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: PALETTES[project.color as keyof typeof PALETTES]?.['500'] }" :title="`Cor: ${project.color}`" />
        <span v-if="project.id === projects.current" class="text-[10px] text-emerald-300">atual</span>
      </RouterLink>
    </template>

    <template #detail>
      <template v-if="adding && auth.isAdmin">
        <h2 class="mx-auto mb-4 max-w-3xl text-lg font-semibold">Novo projeto</h2>
        <div class="mx-auto mb-4 flex max-w-3xl gap-1 rounded-full bg-zinc-900 p-1 text-sm" role="group" aria-label="Como criar">
          <button type="button" class="flex-1 rounded-full px-3 py-1" :class="mode === 'new' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="mode = 'new'">Criar do zero</button>
          <button type="button" class="flex-1 rounded-full px-3 py-1" :class="mode === 'connect' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="mode = 'connect'">Conectar de outro gateway</button>
        </div>
        <form v-if="mode === 'connect'" class="mx-auto flex max-w-3xl flex-col gap-3" data-test="connect-form" @submit.prevent="connectProject">
          <p class="text-xs text-zinc-400">
            Usa aqui o projeto de outro gateway (a origem): agentes, skills, comandos, specs e regras chegam de lá, só leitura, com um aviso quando houver versão nova.
            Os modelos, as conversas, as variáveis e o repositório ficam nesta máquina. O token de conexão é criado na origem, em Conta → Tokens, por um membro do projeto.
          </p>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">Endereço da origem<input v-model="link.url" required class="input" placeholder="https://gateway.empresa.com" /></label>
            <label class="field">Id do projeto na origem<input v-model="link.projectId" required pattern="[a-z0-9][a-z0-9-]{1,31}" class="input font-mono" placeholder="logiccus" /></label>
          </div>
          <label class="field">
            Token de conexão
            <input v-model="link.token" required type="password" autocomplete="off" class="input font-mono" placeholder="agc_…" />
            <small class="hint">Fica guardado cifrado nesta máquina e nunca volta para a tela.</small>
          </label>
          <p v-if="formError" class="text-sm text-rose-300">{{ formError }}</p>
          <div class="flex gap-2">
            <button type="submit" class="btn btn-primary" :disabled="connecting">{{ connecting ? 'Conectando…' : 'Conectar projeto' }}</button>
            <RouterLink to="/projects" class="btn btn-ghost">Cancelar</RouterLink>
          </div>
        </form>
        <form v-else class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="create">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">Nome<input v-model="form.name" required class="input" placeholder="Loja XPTO" @blur="slug" /><small v-for="m in formIssues.name" :key="m" class="error">{{ m }}</small></label>
            <label class="field">
              Id
              <input v-model="form.id" required pattern="[a-z0-9][a-z0-9-]{1,31}" class="input font-mono" placeholder="xpto" />
              <small class="hint">Nome da pasta do projeto (<code>data/projects/{{ form.id || 'id' }}</code>). Não muda depois.</small>
              <small v-for="m in formIssues.id" :key="m" class="error">{{ m }}</small>
            </label>
          </div>
          <label class="field">Descrição <span class="hint">opcional</span><textarea v-model="form.description" rows="3" class="input text-sm" /></label>
          <p v-if="formError" class="text-sm text-rose-300">{{ formError }}</p>
          <div class="flex gap-2">
            <button type="submit" class="btn btn-primary">Criar projeto</button>
            <RouterLink to="/projects" class="btn btn-ghost">Cancelar</RouterLink>
          </div>
        </form>
      </template>

      <ProjectSettings v-else-if="selected" :key="selected.id" :project-id="selected.id" system />
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um projeto ou crie um novo.</div>
    </template>
  </MasterDetail>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex min-w-0 flex-col gap-1.5 text-sm font-medium text-zinc-300;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
.hint {
  @apply text-xs font-normal text-zinc-500;
}
.error {
  @apply text-xs font-normal text-rose-300;
}
</style>
