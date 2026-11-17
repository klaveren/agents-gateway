<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useResource } from '@/composables/useResource'
import { ApiError } from '@/lib/api'
import { initials } from '@/lib/format'
import { applyAccent, PALETTES, PROJECT_COLOR_LABEL, PROJECT_COLORS, projectGradient } from '@/lib/projectColors'
import type { TProjectRole } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useConnectionsStore } from '@/stores/connections'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'
import { useUsersStore } from '@/stores/users'
import ConfirmDialog from './ConfirmDialog.vue'
import EnvFilesAgents from './EnvFilesAgents.vue'
import ProjectConnectionCard from './ProjectConnectionCard.vue'
import ProjectServices from './ProjectServices.vue'
import SaveFooter from './SaveFooter.vue'

/**
 * A CONFIGURAÇÃO de um projeto, em guias: os dados dele, os membros, os serviços do ambiente (as regras de rede exatas)
 * e quem lê os `.env`. Mora em Projeto → Configurações (o projeto em uso) e em Sistema → Projetos (qualquer um, com
 * criar, usar e apagar). Nome, descrição e membros: quem administra o projeto, ou o admin do gateway como resgate; os
 * serviços e os `.env` só quem administra o projeto (as regras são dele).
 */
const props = defineProps<{ projectId: string; system?: boolean }>()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const users = useUsersStore()
const settings = useSettingsStore()
const connections = useConnectionsStore()

type TProjectTab = 'projeto' | 'membros' | 'servicos' | 'env'
const tab = ref<TProjectTab>('projeto')
const sandbox = computed(() => settings.current?.deployment?.sandbox)

const selected = computed(() => projects.list.find((project) => project.id === props.projectId))
const canEdit = computed(() => !!selected.value && (selected.value.role === 'admin' || auth.isAdmin))
/** As regras do projeto são de quem o administra (o admin do gateway sem papel nele não as lê). */
const managesThis = computed(() => selected.value?.role === 'admin')
/** 🔌 A cópia só de leitura de um projeto de outro gateway. */
const connected = computed(() => connections.byProject.has(props.projectId))
/** Os `.env` se marcam por agente, e a lista de agentes é a do projeto em uso. */
const envTab = computed(() => managesThis.value && props.projectId === projects.current)

const edit = ref({ name: '', description: '', color: 'emerald' })
const memberList = useResource(projects.memberLists, () => (canEdit.value ? props.projectId : undefined))
const savedMembers = computed(() => new Map((memberList.data.value ?? []).map((member) => [member.userId, member.role] as const)))
const members = ref<Map<string, TProjectRole>>(new Map())
watch(savedMembers, (saved) => (members.value = new Map(saved)), { immediate: true })
/** ⛔ Todo projeto fica com ao menos um administrador. */
const noAdmin = computed(() => members.value.size > 0 && ![...members.value.values()].includes('admin'))
const busy = ref(false)
const error = ref<string>()
const note = ref<string>()
const removing = ref(false)
const removeError = ref<string>()

onMounted(async () => {
  // As contas e as configurações são do gateway: quem só administra o projeto pode não ler (a lista de membros fica vazia).
  await Promise.all([users.ensure(), auth.isAdmin ? settings.ensure() : undefined]).catch(() => undefined)
  connections.follow()
})

watch(
  selected,
  (project, previous) => {
    if (!project || project.id === previous?.id) return
    edit.value = { name: project.name, description: project.description ?? '', color: project.color ?? 'emerald' }
    error.value = undefined
    note.value = undefined
  },
  { immediate: true },
)
watch(envTab, (open) => {
  if (!open && tab.value === 'env') tab.value = 'projeto'
})

function describe(failure: unknown): string {
  if (failure instanceof ApiError && failure.status === 422) {
    const items = Array.isArray(failure.details) ? (failure.details as Array<{ field?: string; message?: string }>) : []
    return items.map((item) => (item.field ? `${item.field}: ${item.message}` : item.message)).join('; ') || failure.message
  }
  if (failure instanceof ApiError && failure.code === 'project_in_use') return `${failure.message}. Mova ou apague esses agentes antes.`
  return failure instanceof Error ? failure.message : String(failure)
}

const dirty = computed(() => !!selected.value && (edit.value.name !== selected.value.name || edit.value.description !== (selected.value.description ?? '')))
/** 🎨 A cor escolhida e ainda não salva. Desta máquina: muda também no projeto conectado. */
const colorDirty = computed(() => !!selected.value && edit.value.color !== (selected.value.color ?? 'emerald'))
// A cor escolhida já aparece na tela (a prévia) quando o projeto é o atual; sair sem salvar volta a do projeto.
watch(
  () => [edit.value.color, selected.value?.id, projects.current] as const,
  () => applyAccent(selected.value?.id === projects.current ? edit.value.color : projects.currentProject?.color),
)
onBeforeUnmount(() => applyAccent(projects.currentProject?.color))
const membersDirty = computed(() => members.value.size !== savedMembers.value.size || [...members.value].some(([id, role]) => savedMembers.value.get(id) !== role))

async function saveProject(): Promise<void> {
  busy.value = true
  error.value = undefined
  note.value = undefined
  try {
    if (dirty.value) await projects.update(props.projectId, { name: edit.value.name, description: edit.value.description })
    if (colorDirty.value) await projects.setColor(props.projectId, edit.value.color === 'emerald' ? undefined : edit.value.color)
    if (membersDirty.value)
      await projects.setMembers(
        props.projectId,
        [...members.value].map(([userId, role]) => ({ userId, role })),
      )
    note.value = 'Projeto salvo.'
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

function toggleMember(id: string): void {
  const next = new Map(members.value)
  if (next.has(id)) next.delete(id)
  else next.set(id, 'member')
  members.value = next
}

function setRole(id: string, role: TProjectRole): void {
  members.value = new Map(members.value).set(id, role)
}

async function confirmRemove(): Promise<void> {
  removeError.value = undefined
  try {
    await projects.remove(props.projectId)
    removing.value = false
    await router.push('/projects')
  } catch (failure) {
    removeError.value = describe(failure)
  }
}

const tabs = computed(() => [
  { id: 'projeto' as const, label: 'Projeto', count: 0, unsaved: dirty.value || colorDirty.value },
  { id: 'membros' as const, label: 'Membros', count: members.value.size, unsaved: membersDirty.value },
  ...(managesThis.value ? [{ id: 'servicos' as const, label: 'Serviços', count: 0, unsaved: false }] : []),
  ...(envTab.value ? [{ id: 'env' as const, label: 'Arquivos .env', count: selected.value?.envFileAgents?.length ?? 0, unsaved: false }] : []),
])
</script>

<template>
  <section v-if="selected" class="mx-auto flex max-w-3xl flex-col gap-4" data-test="project-settings">
    <div class="flex items-center gap-3">
      <span
        :style="projectGradient(edit.color) ? { background: projectGradient(edit.color) } : undefined"
        class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 to-accent-end text-base font-bold text-zinc-950"
        >{{ initials(selected.name) }}</span
      >
      <div class="min-w-0">
        <h2 class="truncate text-lg font-semibold">{{ selected.name }}</h2>
        <p class="truncate font-mono text-xs text-zinc-500">{{ selected.id }}</p>
      </div>
      <button v-if="system && selected.id !== projects.current" type="button" class="btn btn-secondary ml-auto" @click="projects.select(selected.id)">Usar este projeto</button>
    </div>

    <nav class="flex gap-1 overflow-x-auto border-b border-zinc-800" role="tablist">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        role="tab"
        :aria-selected="tab === item.id"
        :data-test="`project-tab-${item.id}`"
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
        <p v-if="sandbox?.available" class="mt-2 text-success-300">✓ Os agentes só acessam arquivos desta pasta.</p>
        <p v-else-if="sandbox" class="mt-2 text-amber-300">⚠ O isolamento da pasta não está disponível. Peça a quem cuida do servidor.</p>
      </div>

      <div class="grid gap-3">
        <label class="field">Nome<input v-model="edit.name" :disabled="!canEdit || connected" class="input" /></label>
        <label class="field">Descrição<textarea v-model="edit.description" :disabled="!canEdit || connected" rows="2" class="input text-sm" /></label>
        <div class="field" data-test="project-color">
          Cor do projeto
          <span class="hint">o destaque da tela neste projeto, só nesta máquina; mensagens de sucesso seguem verdes</span>
          <div class="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Cor do projeto">
            <button
              v-for="color in PROJECT_COLORS"
              :key="color"
              type="button"
              role="radio"
              :aria-checked="edit.color === color"
              :disabled="!canEdit"
              :title="PROJECT_COLOR_LABEL[color]"
              class="h-7 w-7 rounded-full ring-offset-2 ring-offset-zinc-950 transition"
              :class="edit.color === color ? 'ring-2 ring-zinc-100' : 'hover:ring-2 hover:ring-zinc-500'"
              :style="{ background: PALETTES[color]['500'] }"
              :data-color="color"
              @click="edit.color = color"
            />
          </div>
        </div>
      </div>
    </div>

    <div v-show="tab === 'membros'" class="flex flex-col gap-2" role="tabpanel">
      <p class="text-xs text-zinc-500">
        Quem pode ver este projeto. O administrador do projeto cuida de tudo dele (agentes, catálogo, permissões, membros); o membro conversa com os agentes. Todo projeto
        precisa de ao menos um administrador.
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

    <div v-if="tab === 'servicos'" role="tabpanel">
      <ProjectServices :project-id="selected.id" :read-only="connected" />
    </div>

    <div v-if="tab === 'env'" class="flex flex-col gap-2" role="tabpanel">
      <p class="text-xs text-zinc-500">Os .env ficam fechados para todo agente. Aqui você abre a leitura, agente por agente, para o ambiente de desenvolvimento subir.</p>
      <EnvFilesAgents :project-id="selected.id" />
    </div>

    <template v-if="tab === 'projeto' || tab === 'membros'">
      <p v-if="note" class="text-sm text-success-300">{{ note }}</p>
      <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <SaveFooter
        v-if="canEdit"
        label="Salvar projeto"
        :busy="busy"
        :disabled="(!dirty && !membersDirty && !colorDirty) || noAdmin"
        :pending="dirty || membersDirty || colorDirty"
        @save="saveProject"
      >
        <template #end>
          <button v-if="system && auth.isAdmin && !connected" type="button" class="btn btn-danger" @click="(removing = true), (removeError = undefined)">Apagar projeto</button>
        </template>
      </SaveFooter>
    </template>

    <ConfirmDialog
      :open="removing"
      :title="`Apagar o projeto ${selected.name}?`"
      :message="removeError ?? 'Apaga o projeto, os membros e os arquivos da pasta. Só funciona sem agentes no projeto.'"
      action="Apagar"
      @confirm="confirmRemove"
      @cancel="removing = false"
    />
  </section>
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
</style>
