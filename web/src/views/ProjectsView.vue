<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import { ApiError } from '@/lib/api'
import { initials } from '@/lib/format'
import type { IProject } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useUsersStore } from '@/stores/users'
import { useSettingsStore } from '@/stores/settings'

/**
 * A guia Projetos (só admin): cada projeto tem a sua pasta, os seus agentes e conversas, e os seus membros.
 * ⚖️ O admin vê todos; cada membro, só os projetos em que está.
 */
const props = defineProps<{ id?: string }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const users = useUsersStore()
const settings = useSettingsStore()
const sandbox = computed(() => settings.current?.deployment?.sandbox)

const adding = computed(() => route.name === 'project-new')
const selected = computed(() => (props.id ? projects.list.find((project) => project.id === props.id) : undefined))

const loadError = ref<string>()
const form = ref({ id: '', name: '', description: '' })
const formIssues = ref<Record<string, string[]>>({})
const formError = ref<string>()
const edit = ref({ name: '', description: '' })
const members = ref<Set<string>>(new Set())
const savedMembers = ref<Set<string>>(new Set())
const busy = ref(false)
const error = ref<string>()
const note = ref<string>()
const removing = ref<IProject>()
const removeError = ref<string>()

onMounted(async () => {
  if (!auth.isAdmin) return
  await Promise.all([projects.load(), users.load(), settings.current ? undefined : settings.load()]).catch((failure) => (loadError.value = describe(failure)))
})

watch(
  selected,
  async (project, previous) => {
    if (!project || project.id === previous?.id) return
    edit.value = { name: project.name, description: project.description ?? '' }
    error.value = undefined
    note.value = undefined
    const list = await projects.members(project.id).catch(() => [])
    savedMembers.value = new Set(list.map((member) => member.userId))
    members.value = new Set(savedMembers.value)
  },
  { immediate: true },
)

function describe(failure: unknown): string {
  if (failure instanceof ApiError && failure.status === 422) {
    const items = Array.isArray(failure.details) ? (failure.details as Array<{ field?: string; message?: string }>) : []
    return items.map((item) => (item.field ? `${item.field}: ${item.message}` : item.message)).join('; ') || failure.message
  }
  if (failure instanceof ApiError && failure.code === 'project_in_use') return `${failure.message}. Mova ou apague esses agentes antes.`
  return failure instanceof Error ? failure.message : String(failure)
}

function slug() {
  if (form.value.id) return
  form.value.id = form.value.name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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

async function run(work: () => Promise<void>, done?: string) {
  busy.value = true
  error.value = undefined
  note.value = undefined
  try {
    await work()
    note.value = done
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

const dirty = computed(() => !!selected.value && (edit.value.name !== selected.value.name || edit.value.description !== (selected.value.description ?? '')))
const membersDirty = computed(() => members.value.size !== savedMembers.value.size || [...members.value].some((id) => !savedMembers.value.has(id)))
const save = () => run(() => projects.update(selected.value!.id, { name: edit.value.name, description: edit.value.description }), 'Projeto salvo.')
const saveMembers = () =>
  run(async () => {
    await projects.setMembers(selected.value!.id, [...members.value])
    savedMembers.value = new Set(members.value)
  }, 'Membros salvos.')
function toggleMember(id: string) {
  const next = new Set(members.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  members.value = next
}

async function confirmRemove() {
  const target = removing.value
  if (!target) return
  removeError.value = undefined
  try {
    await projects.remove(target.id)
    removing.value = undefined
    await router.push('/projects')
  } catch (failure) {
    removeError.value = describe(failure)
  }
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra cadastra os projetos.</p>
  </div>

  <MasterDetail v-else :open="!!id || adding" back-to="/projects" back-label="Projetos" :title="adding ? 'Novo projeto' : selected?.name">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-1">
        <h1 class="text-xl font-semibold">Projetos</h1>
        <RouterLink to="/projects/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Novo projeto"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <p class="px-4 pb-3 text-xs text-zinc-500">Cada projeto tem os seus agentes, conversas e pasta. Modelos, MCPs e pacotes são do sistema e valem para todos; o Atlas é global.</p>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <p v-if="!projects.list.length && !loadError" class="px-4 py-2 text-sm text-zinc-500">Nenhum projeto ainda.</p>
      <RouterLink
        v-for="project in projects.list"
        :key="project.id"
        :to="`/projects/${project.id}`"
        class="mx-2 flex items-center gap-3 rounded-xl px-3 py-2"
        :class="project.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'"
      >
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-emerald-400/30 to-teal-600/30 text-xs font-semibold text-emerald-200">{{ initials(project.name) }}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ project.name }}</span>
          <span class="block truncate text-xs text-zinc-500">{{ project.id }} · {{ project.members ?? 0 }} membro(s)</span>
        </span>
        <span v-if="project.id === projects.current" class="text-[10px] text-emerald-300">atual</span>
      </RouterLink>
    </template>

    <template #detail>
      <template v-if="adding">
        <h2 class="mx-auto mb-4 max-w-3xl text-lg font-semibold">Novo projeto</h2>
        <form class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="create">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">Nome<input v-model="form.name" required class="input" placeholder="Loja XPTO" @blur="slug" /><small v-for="m in formIssues.name" :key="m" class="error">{{ m }}</small></label>
            <label class="field">
              Id
              <input v-model="form.id" required pattern="[a-z0-9][a-z0-9-]{1,31}" class="input font-mono" placeholder="xpto" />
              <small class="hint">Vira o nome da pasta (<code>data/projects/{{ form.id || 'id' }}</code>). Não muda depois.</small>
              <small v-for="m in formIssues.id" :key="m" class="error">{{ m }}</small>
            </label>
          </div>
          <label class="field">Descrição <span class="hint">opcional</span><textarea v-model="form.description" rows="3" class="input text-sm" /></label>
          <p v-if="formError" class="text-sm text-rose-300">{{ formError }}</p>
          <div class="flex gap-2">
            <button type="submit" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">Criar projeto</button>
            <RouterLink to="/projects" class="rounded-full px-4 py-2 text-sm hover:bg-zinc-800">Cancelar</RouterLink>
          </div>
        </form>
      </template>

      <section v-else-if="selected" :key="selected.id" class="mx-auto flex max-w-3xl flex-col gap-4">
        <div class="flex items-center gap-3">
          <span class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 text-base font-bold text-zinc-950">{{ initials(selected.name) }}</span>
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold">{{ selected.name }}</h2>
            <p class="truncate font-mono text-xs text-zinc-500">{{ selected.id }}</p>
          </div>
          <button v-if="selected.id !== projects.current" type="button" class="ml-auto rounded-full bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700" @click="projects.select(selected.id)">Usar este projeto</button>
        </div>

        <p class="text-xs text-zinc-500">
          O que toda conversa do projeto recebe — rules e specs inteiras — fica em <RouterLink to="/environment" class="text-emerald-400 underline underline-offset-2">Projeto → Ambiente</RouterLink>
          (com este projeto em uso).
        </p>


        <div class="rounded-xl border border-zinc-800 p-3 text-xs text-zinc-400">
          <div class="mb-1 font-medium text-zinc-300">Pasta</div>
          <code class="block truncate text-zinc-200">{{ selected.folder }}</code>
          <p class="mt-2 text-zinc-400">Os agentes do projeto trabalham nesta pasta, persistente e compartilhada pelas conversas dele.</p>
          <p v-if="sandbox?.available" class="mt-2 text-emerald-300">
            ✓ Cerco ativo ({{ sandbox.mechanism }}): o Bash e o run_bash dos agentes do projeto só leem e gravam nesta pasta, com a rede liberada. As ferramentas de arquivo do Claude (Read, Write, Edit, Glob, Grep) também ficam presas a ela.
          </p>
          <p v-else-if="sandbox" class="mt-2 text-amber-300">
            ⚠ Cerco indisponível neste servidor{{ sandbox.reason ? `: ${sandbox.reason}` : '' }}. O Bash e o run_bash dos agentes de projeto ficam bloqueados; as ferramentas de arquivo do Claude continuam presas à pasta. No Linux em
            contêiner, o seccomp do pod precisa liberar user namespaces.
          </p>
          <p class="mt-2 text-zinc-500">Codex: grava só na pasta (workspace-write), mas lê fora. Antigravity: sem o sandbox "full". O agente global (Atlas) não passa pelo cerco.</p>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="field">Nome<input v-model="edit.name" class="input" /></label>
          <label class="field sm:col-span-2">Descrição<textarea v-model="edit.description" rows="2" class="input text-sm" /></label>
        </div>
        <div v-if="dirty" class="flex gap-2">
          <button type="button" :disabled="busy" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="save">Salvar</button>
        </div>

        <div class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-medium text-zinc-200">Membros</h3>
            <span class="text-xs text-zinc-500">quem vê este projeto (o admin vê todos)</span>
          </div>
          <ul class="divide-y divide-zinc-800">
            <li v-for="user in users.list" :key="user.id" class="flex items-center gap-3 py-1.5">
              <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" class="accent-emerald-500" :checked="members.has(user.id)" @change="toggleMember(user.id)" />
                <span class="min-w-0 flex-1 truncate">{{ user.name }} <span class="text-xs text-zinc-500">{{ user.email }}</span></span>
                <span v-if="user.role === 'admin'" class="text-[10px] text-zinc-500">admin</span>
              </label>
            </li>
          </ul>
          <div v-if="membersDirty" class="flex gap-2">
            <button type="button" :disabled="busy" class="rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="saveMembers">Salvar membros</button>
          </div>
        </div>

        <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
        <div class="flex justify-end text-xs">
          <button type="button" class="text-rose-300 hover:underline" @click="(removing = selected), (removeError = undefined)">Apagar projeto</button>
        </div>
      </section>
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um projeto ou crie um novo.</div>

      <ConfirmDialog
        :open="!!removing"
        :title="`Apagar o projeto ${removing?.name ?? ''}?`"
        :message="removeError ?? 'Some o cadastro, os membros e a PASTA do projeto (os arquivos dela). Com agente dentro, o gateway recusa e diz quais.'"
        action="Apagar"
        @confirm="confirmRemove"
        @cancel="removing = undefined"
      />
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
