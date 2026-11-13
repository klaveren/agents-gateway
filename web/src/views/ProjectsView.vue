<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import SaveFooter from '@/components/SaveFooter.vue'
import ProjectConnectionCard from '@/components/ProjectConnectionCard.vue'
import { useConnectionsStore } from '@/stores/connections'
import Icon from '@/components/Icon.vue'
import ListFilter from '@/components/ListFilter.vue'
import { countLabel, filterList, sortByName } from '@/lib/listFilter'
import MasterDetail from '@/components/MasterDetail.vue'
import { useResource } from '@/composables/useResource'
import { ApiError } from '@/lib/api'
import { initials } from '@/lib/format'
import type { IProject, TProjectRole } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useUsersStore } from '@/stores/users'
import { useSettingsStore } from '@/stores/settings'

/**
 * A guia Projetos: cada projeto tem a sua pasta, os seus agentes e conversas, e os seus membros. Criar e apagar é do admin
 * do gateway; nome, descrição e membros, de quem administra o projeto (o admin do gateway também, como resgate).
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
const users = useUsersStore()
/** As guias do projeto aberto, como no agente: os dados dele e quem o vê. */
type TProjectTab = 'projeto' | 'membros'
const tab = ref<TProjectTab>('projeto')
const settings = useSettingsStore()
const sandbox = computed(() => settings.current?.deployment?.sandbox)

const adding = computed(() => route.name === 'project-new')
const selected = computed(() => (props.id ? projects.list.find((project) => project.id === props.id) : undefined))
/** Abre a guia: o admin do gateway, ou quem administra algum projeto. */
const canOpen = computed(() => auth.isAdmin || projects.managesAny)
/** Edita o projeto aberto (nome, descrição, membros): o admin dele ou o do gateway. */
const canEdit = computed(() => !!selected.value && (selected.value.role === 'admin' || auth.isAdmin))

const connections = useConnectionsStore()
/** 🔌 O projeto aberto é a cópia só de leitura de um projeto de outro gateway. */
const connected = computed(() => (selected.value ? connections.byProject.has(selected.value.id) : false))
/** Criar do zero, ou conectar um projeto de outro gateway (a .4): o catálogo vem de lá, só leitura. */
const mode = ref<'new' | 'connect'>('new')
const link = ref({ url: '', projectId: '', token: '' })
const connecting = ref(false)

const loadError = ref<string>()
const form = ref({ id: '', name: '', description: '' })
const formIssues = ref<Record<string, string[]>>({})
const formError = ref<string>()
const edit = ref({ name: '', description: '' })
/** Os membros gravados do projeto aberto, da store (lidos uma vez; salvar põe a resposta lá). */
const memberList = useResource(projects.memberLists, () => (canEdit.value ? selected.value?.id : undefined))
const savedMembers = computed(() => new Map((memberList.data.value ?? []).map((member) => [member.userId, member.role] as const)))
/** A marcação em edição (conta → papel): volta à gravada quando o projeto (ou o gravado) muda. */
const members = ref<Map<string, TProjectRole>>(new Map())
watch(savedMembers, (saved) => (members.value = new Map(saved)), { immediate: true })
/** ⛔ Todo projeto fica com ao menos um administrador: sem nenhum, o salvar fica desligado e a guia avisa. */
const noAdmin = computed(() => members.value.size > 0 && ![...members.value.values()].includes('admin'))
const busy = ref(false)
const error = ref<string>()
const note = ref<string>()
const removing = ref<IProject>()
const removeError = ref<string>()

onMounted(async () => {
  await projects.ensure().catch((failure) => (loadError.value = describe(failure)))
  if (!canOpen.value) return
  // As contas e as configurações são do gateway: quem só administra o projeto pode não ler (a lista de membros fica vazia).
  await Promise.all([users.ensure(), auth.isAdmin ? settings.ensure() : undefined]).catch(() => undefined)
  connections.follow()
})

watch(
  selected,
  (project, previous) => {
    if (!project || project.id === previous?.id) return
    edit.value = { name: project.name, description: project.description ?? '' }
    error.value = undefined
    note.value = undefined
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
const membersDirty = computed(() => members.value.size !== savedMembers.value.size || [...members.value].some(([id, role]) => savedMembers.value.get(id) !== role))
/** Um salvar só: o nome e a descrição (guia Projeto) e os membros (guia Membros), o que mudou. */
const saveProject = () =>
  run(async () => {
    if (dirty.value) await projects.update(selected.value!.id, { name: edit.value.name, description: edit.value.description })
    if (membersDirty.value)
      await projects.setMembers(
        selected.value!.id,
        [...members.value].map(([userId, role]) => ({ userId, role })),
      )
  }, 'Projeto salvo.')
function toggleMember(id: string) {
  const next = new Map(members.value)
  if (next.has(id)) next.delete(id)
  else next.set(id, 'member')
  members.value = next
}

function setRole(id: string, role: TProjectRole) {
  members.value = new Map(members.value).set(id, role)
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
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-emerald-400/30 to-teal-600/30 text-xs font-semibold text-emerald-200">{{ initials(project.name) }}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ project.name }}</span>
          <span class="block truncate text-xs text-zinc-500">{{ project.id }} · {{ project.members ?? 0 }} membro(s)</span>
        </span>
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

      <section v-else-if="selected" :key="selected.id" class="mx-auto flex max-w-3xl flex-col gap-4">
        <div class="flex items-center gap-3">
          <span class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 text-base font-bold text-zinc-950">{{ initials(selected.name) }}</span>
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold">{{ selected.name }}</h2>
            <p class="truncate font-mono text-xs text-zinc-500">{{ selected.id }}</p>
          </div>
          <button v-if="selected.id !== projects.current" type="button" class="btn btn-secondary ml-auto" @click="projects.select(selected.id)">Usar este projeto</button>
        </div>

        <nav class="flex gap-1 border-b border-zinc-800" role="tablist">
          <button
            v-for="item in [
              { id: 'projeto', label: 'Projeto', count: 0, unsaved: dirty },
              { id: 'membros', label: 'Membros', count: members.size, unsaved: membersDirty },
            ] as const"
            :key="item.id"
            type="button"
            role="tab"
            :aria-selected="tab === item.id"
            class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
            :class="tab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
            @click="tab = item.id"
          >
            {{ item.label }}
            <span v-if="item.count" class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">{{ item.count }}</span>
            <span v-if="item.unsaved" class="h-1.5 w-1.5 rounded-full bg-amber-400" title="Mudança não salva" />
          </button>
        </nav>

        <div v-show="tab === 'projeto'" class="flex flex-col gap-4" role="tabpanel">
          <ProjectConnectionCard v-if="connected" :project-id="selected.id" />
          <p class="text-xs text-zinc-500">
            Regras e specs do projeto ficam em <RouterLink to="/environment" class="text-emerald-400 underline underline-offset-2">Projeto → Ambiente</RouterLink>.
          </p>


          <div class="rounded-xl border border-zinc-800 p-3 text-xs text-zinc-400">
            <div class="mb-1 font-medium text-zinc-300">Pasta</div>
            <code class="block truncate text-zinc-200">{{ selected.folder }}</code>
            <p class="mt-2 text-zinc-400">Pasta de trabalho dos agentes deste projeto.</p>
            <p v-if="sandbox?.available" class="mt-2 text-emerald-300">
              ✓ Os agentes só acessam arquivos desta pasta.
            </p>
            <p v-else-if="sandbox" class="mt-2 text-amber-300">
              ⚠ O isolamento da pasta não está disponível. Peça a quem cuida do servidor.
            </p>
          </div>

          <div class="grid gap-3">
            <label class="field">Nome<input v-model="edit.name" :disabled="!canEdit || connected" class="input" /></label>
            <label class="field">Descrição<textarea v-model="edit.description" :disabled="!canEdit || connected" rows="2" class="input text-sm" /></label>
          </div>
        </div>

        <div v-show="tab === 'membros'" class="flex flex-col gap-2" role="tabpanel">
          <p class="text-xs text-zinc-500">
            Quem pode ver este projeto. O administrador do projeto cuida de tudo dele (agentes, catálogo, permissões, membros); o membro conversa com os agentes. Todo
            projeto precisa de ao menos um administrador.
          </p>
          <p v-if="!canEdit" class="text-xs text-amber-300">Só quem administra este projeto altera.</p>
          <fieldset :disabled="!canEdit" class="contents">
          <ul class="divide-y divide-zinc-800">
            <li v-for="user in users.list" :key="user.id" class="flex items-center gap-3 py-1.5">
              <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" class="accent-emerald-500" :checked="members.has(user.id)" @change="toggleMember(user.id)" />
                <span class="min-w-0 flex-1 truncate">{{ user.name }} <span class="text-xs text-zinc-500">{{ user.email }}</span></span>
                <span v-if="user.role === 'admin'" class="text-[10px] text-zinc-500" title="Administra o gateway (provedores, usuários, configurações)">gateway</span>
              </label>
              <select
                v-if="members.has(user.id)"
                :value="members.get(user.id)"
                class="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs"
                :aria-label="`Papel de ${user.name}`"
                @change="setRole(user.id, ($event.target as HTMLSelectElement).value as TProjectRole)"
              >
                <option value="admin">Administrador</option>
                <option value="member">Membro</option>
              </select>
            </li>
          </ul>
          </fieldset>
          <p v-if="noAdmin" class="text-xs text-amber-300">Escolha ao menos um administrador para o projeto.</p>
        </div>

        <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
        <SaveFooter v-if="canEdit" label="Salvar projeto" :busy="busy" :disabled="(!dirty && !membersDirty) || noAdmin" :pending="dirty || membersDirty" @save="saveProject">
          <template #end>
            <button v-if="auth.isAdmin && !connected" type="button" class="btn btn-danger" @click="(removing = selected), (removeError = undefined)">Apagar projeto</button>
          </template>
        </SaveFooter>
      </section>
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um projeto ou crie um novo.</div>

      <ConfirmDialog
        :open="!!removing"
        :title="`Apagar o projeto ${removing?.name ?? ''}?`"
        :message="removeError ?? 'Apaga o projeto, os membros e os arquivos da pasta. Só funciona sem agentes no projeto.'"
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
