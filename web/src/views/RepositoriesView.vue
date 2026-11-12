<script setup lang="ts">
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import SaveFooter from '@/components/SaveFooter.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ApiError } from '@/lib/api'
import { useResource } from '@/composables/useResource'
import ListPager from '@/components/ListPager.vue'
import { usePaged } from '@/composables/usePaged'
import { useAccountsStore } from '@/stores/accounts'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { type IProjectRepository, useRepositoriesStore } from '@/stores/repositories'
import { useSettingsStore } from '@/stores/settings'

/**
 * Os REPOSITÓRIOS do projeto em uso (só quem o administra): cada um é uma pasta com git em `repositories/`, onde as
 * conversas abrem. A tela lista (branch, origem, worktrees), clona de uma URL https com uma conta do projeto, cria um
 * git LOCAL (sem remoto) e remove. Num projeto conectado o repositório é desta máquina: a origem não o recebe.
 *
 * A guia "Regras do git" é desta INSTALAÇÃO, não do projeto (só o admin do gateway): a branch base das worktrees, o
 * prefixo e as protegidas (ver `Git.Guard` no servidor). Ela tem o salvar dela; criar e remover gravam na hora.
 */
type TTab = 'repositories' | 'rules'

const route = useRoute()
const auth = useAuthStore()
const projects = useProjectsStore()
const store = useRepositoriesStore()
const accountsStore = useAccountsStore()
const settings = useSettingsStore()
const project = computed(() => projects.list.find((item) => item.id === projects.current))

/** O admin do gateway sem papel no projeto vê só as regras (chega pelo link da Configuração). */
const tabs = computed<Array<{ id: TTab; label: string }>>(() => [
  ...(projects.manages ? [{ id: 'repositories' as const, label: 'Repositórios' }] : []),
  ...(auth.isAdmin ? [{ id: 'rules' as const, label: 'Regras do git' }] : []),
])
const chosen = ref<TTab>(route.hash === '#regras' ? 'rules' : 'repositories')
const tab = computed(() => (tabs.value.some((item) => item.id === chosen.value) ? chosen.value : tabs.value[0]?.id))

/** Lê quando a tela abre (só admin do projeto, com a lista de projetos). */
const ready = ref(false)
const key = () => (ready.value && project.value ? project.value.id : undefined)
const listed = useResource(store.lists, key)
const repositories = computed(() => listed.data.value ?? [])
const repositoryPage = usePaged(repositories, { by: (item) => item.name })
/** As contas que servem ao clone: as de git por https. */
const accountList = useResource(accountsStore.lists, key)
const gitAccounts = computed(() => (accountList.data.value ?? []).filter((item) => item.kind === 'github-app' || item.kind === 'github-token' || item.kind === 'git-https'))

const text = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))
const actionError = ref<string>()
const error = computed(() => actionError.value ?? (listed.error.value === undefined ? undefined : text(listed.error.value)))
const notice = ref<string>()

/** O formulário de criar: clonar de uma URL, ou um git local (sem remoto). */
const adding = ref(false)
const mode = ref<'clone' | 'local'>('clone')
const blank = () => ({ url: '', name: '', account: '', branch: '' })
const form = ref(blank())
const busy = ref(false)
/** Os problemas de um 422, por campo. */
const issues = ref<Record<string, string[]>>({})

function startNew() {
  adding.value = true
  mode.value = 'clone'
  form.value = blank()
  issues.value = {}
  notice.value = undefined
  actionError.value = undefined
}

async function add() {
  if (!project.value || busy.value) return
  busy.value = true
  actionError.value = undefined
  notice.value = undefined
  issues.value = {}
  try {
    const { url, name, account, branch } = form.value
    const optional = { ...(name.trim() ? { name: name.trim() } : {}), ...(branch.trim() ? { branch: branch.trim() } : {}) }
    const created = await store.add(project.value.id, mode.value === 'clone' ? { url: url.trim(), ...optional, ...(account ? { account } : {}) } : optional)
    notice.value = created.origin ? `Repositório ${created.name} clonado.` : `Git local ${created.name} criado${created.branch ? `, na branch ${created.branch}` : ''}: sem remoto.`
    adding.value = false
  } catch (failure) {
    if (failure instanceof ApiError && Object.keys(failure.fieldIssues).length) issues.value = failure.fieldIssues
    else actionError.value = text(failure)
  } finally {
    busy.value = false
  }
}

/** O repositório que espera a confirmação de remover (na tela: o `confirm()` nativo não abre em navegador embutido). */
const removing = ref<IProjectRepository>()
const removeBusy = ref(false)

async function remove() {
  const target = removing.value
  if (!target || !project.value || removeBusy.value) return
  removeBusy.value = true
  actionError.value = undefined
  notice.value = undefined
  try {
    const { kept } = await store.remove(project.value.id, target.name)
    notice.value = kept.length ? `Repositório ${target.name} removido. Ficaram no disco as worktrees de fora de repositories/: ${kept.join(', ')}.` : `Repositório ${target.name} removido.`
  } catch (failure) {
    actionError.value = text(failure)
  } finally {
    removeBusy.value = false
    removing.value = undefined
  }
}

/** ⚠️ O clone pedido por outra aba (ou antes de recarregar) aparece como "clonando": a lista relê até ele acabar. */
let poll: ReturnType<typeof setInterval> | undefined
watch(
  () => repositories.value.some((item) => item.cloning),
  (cloning) => {
    clearInterval(poll)
    poll = cloning ? setInterval(() => void listed.refresh().catch(() => undefined), 3000) : undefined
  },
  { immediate: true },
)
onBeforeUnmount(() => clearInterval(poll))

/** 🌿 As regras do git desta instalação: vazio = o padrão. */
const git = ref({ installationName: '', branchPrefix: '', baseBranch: '', protectedBranches: '', lockMainCheckout: true })
const rulesBusy = ref(false)
const rulesSaved = ref<string>()
const rulesFailure = ref<string>()
const rulesIssues = ref<Array<{ field: string; message: string }>>([])
watch(
  () => settings.current,
  (current) => {
    if (!current) return
    git.value = {
      installationName: current.installationName ?? '',
      branchPrefix: current.branchPrefix ?? '',
      baseBranch: current.baseBranch ?? '',
      protectedBranches: (current.protectedBranches ?? []).join(', '),
      lockMainCheckout: current.lockMainCheckout !== false,
    }
  },
  { immediate: true },
)

async function saveRules() {
  rulesBusy.value = true
  rulesSaved.value = undefined
  rulesFailure.value = undefined
  rulesIssues.value = []
  try {
    // Vazio vira `null`: volta ao padrão em vez de gravar texto em branco.
    const protectedBranches = git.value.protectedBranches.split(/[\s,]+/).filter(Boolean)
    await settings.save({
      installationName: git.value.installationName.trim() || null,
      branchPrefix: git.value.branchPrefix.trim() || null,
      baseBranch: git.value.baseBranch.trim() || null,
      protectedBranches: protectedBranches.length ? protectedBranches : null,
      lockMainCheckout: git.value.lockMainCheckout,
    })
    rulesSaved.value = 'Regras do git salvas. Valem para as próximas conversas.'
  } catch (failure) {
    if (failure instanceof ApiError && Array.isArray(failure.details) && failure.details.length) {
      rulesIssues.value = (failure.details as Array<{ field?: string; message?: string }>).map((item) => ({ field: item.field ?? '', message: item.message ?? 'inválido' }))
      rulesFailure.value = 'Não salvou: corrija o que está abaixo.'
    } else rulesFailure.value = text(failure)
  } finally {
    rulesBusy.value = false
  }
}

onMounted(async () => {
  if (auth.isAdmin) void settings.ensure().catch(() => undefined)
  if (!projects.loaded) await projects.load().catch(() => undefined)
  if (!projects.manages) return
  ready.value = true
})
watch(
  () => projects.current,
  () => {
    adding.value = false
    notice.value = undefined
    actionError.value = undefined
    ready.value = projects.manages
  },
)
</script>

<template>
  <div v-if="!tabs.length" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra este projeto vê os repositórios.</p>
  </div>

  <div v-else class="h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-semibold">Repositórios{{ project ? ` — ${project.name}` : '' }}</h1>
          <p class="text-xs text-zinc-500">Onde as conversas do projeto abrem: cada repositório é uma pasta com git em <code>repositories/</code>.</p>
        </div>
        <button v-if="tab === 'repositories' && project && !adding" type="button" class="btn btn-primary btn-sm" data-test="new-repository" @click="startNew">Novo repositório</button>
      </header>

      <nav v-if="tabs.length > 1" class="no-scrollbar flex gap-1 overflow-x-auto overscroll-x-contain border-b border-zinc-800" role="tablist">
        <button
          v-for="item in tabs"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="tab === item.id"
          :data-test="`tab-${item.id}`"
          class="shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
          :class="tab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
          @click="chosen = item.id"
        >
          {{ item.label }}
        </button>
      </nav>

      <template v-if="tab === 'repositories'">
        <p v-if="!project" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Escolha um projeto no seletor do topo.</p>
        <template v-else>
          <p v-if="error" class="text-sm text-rose-300" data-test="repository-error">{{ error }}</p>
          <p v-if="notice" class="text-sm text-emerald-300" data-test="repository-notice">{{ notice }}</p>

          <form v-if="adding" class="flex flex-col gap-3 rounded-xl border border-zinc-800 p-3" data-test="repository-form" @submit.prevent="add">
            <div class="flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-300">
              <label class="flex items-center gap-2"><input v-model="mode" type="radio" value="clone" class="accent-emerald-500" :disabled="busy" data-test="mode-clone" />Clonar de uma URL</label>
              <label class="flex items-center gap-2"><input v-model="mode" type="radio" value="local" class="accent-emerald-500" :disabled="busy" data-test="mode-local" />Git local (sem remoto)</label>
            </div>
            <p class="text-xs text-zinc-500">
              <template v-if="mode === 'clone'">Só https. O repositório privado usa uma conta de git deste projeto (GitHub ou Git HTTPS, em Contas); o público não precisa de conta.</template>
              <template v-else>Um repositório novo só nesta máquina, com o primeiro commit: nada é publicado. Um remoto pode ser ligado depois, pelo git.</template>
            </p>

            <div class="grid gap-3 sm:grid-cols-2">
              <label v-if="mode === 'clone'" class="field sm:col-span-2">
                URL do repositório
                <input v-model="form.url" class="input font-mono" placeholder="https://github.com/empresa/api.git" :disabled="busy" required data-test="repository-url" />
                <span v-for="message in issues.url" :key="message" class="text-xs font-normal text-rose-300">{{ message }}</span>
              </label>
              <label class="field">
                {{ mode === 'clone' ? 'Nome da pasta (vazio = o da URL)' : 'Nome da pasta' }}
                <input v-model="form.name" class="input font-mono" placeholder="api" maxlength="100" :disabled="busy" :required="mode === 'local'" data-test="repository-name" />
                <span v-for="message in issues.name" :key="message" class="text-xs font-normal text-rose-300">{{ message }}</span>
              </label>
              <label class="field">
                {{ mode === 'clone' ? 'Branch (vazio = a padrão do remoto)' : 'Branch (vazio = a base desta instalação)' }}
                <input v-model="form.branch" class="input font-mono" :placeholder="mode === 'clone' ? 'main' : (settings.current?.baseBranch ?? '')" maxlength="200" :disabled="busy" data-test="repository-branch" />
                <span v-for="message in issues.branch" :key="message" class="text-xs font-normal text-rose-300">{{ message }}</span>
              </label>
              <label v-if="mode === 'clone'" class="field sm:col-span-2">
                Conta
                <select v-model="form.account" class="input" :disabled="busy" data-test="repository-account">
                  <option value="">Nenhuma (repositório público)</option>
                  <option v-for="account in gitAccounts" :key="account.id" :value="account.id">{{ account.label || account.id }} ({{ account.id }})</option>
                </select>
                <span v-for="message in issues.account" :key="message" class="text-xs font-normal text-rose-300">{{ message }}</span>
              </label>
            </div>
            <p v-for="message in issues._" :key="message" class="text-xs text-rose-300">{{ message }}</p>
            <p v-if="busy && mode === 'clone'" class="text-xs text-amber-200">Clonando… um repositório grande leva minutos. Pode sair da tela: ele aparece na lista quando acabar.</p>

            <div class="flex flex-wrap items-center gap-2">
              <button type="submit" class="btn btn-primary" :disabled="busy" data-test="repository-submit">
                {{ mode === 'clone' ? (busy ? 'Clonando…' : 'Clonar') : busy ? 'Criando…' : 'Criar git local' }}
              </button>
              <button type="button" class="btn btn-ghost" :disabled="busy" @click="adding = false">Cancelar</button>
            </div>
          </form>

          <ul v-if="repositories.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800" data-test="repository-list">
            <li v-for="item in repositoryPage.items.value" :key="item.name" class="flex flex-col gap-1.5 px-3 py-2.5" :data-test="`repository-${item.name}`">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono font-medium text-zinc-100">{{ item.name }}</span>
                <span v-if="item.cloning" class="rounded-full border border-amber-500/40 px-2 text-[11px] text-amber-200">clonando…</span>
                <template v-else>
                  <code v-if="item.branch" class="text-xs text-zinc-400" title="A branch da pasta principal">{{ item.branch }}</code>
                  <span v-if="!item.origin" class="rounded-full border border-zinc-700 px-2 text-[11px] text-zinc-400" title="Sem remoto: nada é publicado">local</span>
                  <button type="button" class="btn btn-ghost btn-sm ml-auto text-rose-300" :data-test="`remove-${item.name}`" @click="removing = item">Remover</button>
                </template>
              </div>
              <p v-if="!item.cloning" class="text-xs break-all text-zinc-500">
                <template v-if="item.origin">{{ item.origin }} · </template>
                {{ item.worktrees.length ? `${item.worktrees.length} ${item.worktrees.length === 1 ? 'worktree' : 'worktrees'}: ${item.worktrees.map((worktree) => worktree.name).join(', ')}` : 'sem worktrees' }}
              </p>
            </li>
          </ul>
          <p v-else-if="listed.loading.value" class="text-xs text-zinc-500">Lendo…</p>
          <p v-else-if="!adding && !error" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">
            Este projeto ainda não tem repositório. Clone um ou crie um git local em “Novo repositório”.
          </p>
          <ListPager v-model="repositoryPage.page.value" :pages="repositoryPage.pages.value" :total="repositoryPage.total.value" :size="repositoryPage.size" />
        </template>
      </template>

      <template v-else-if="tab === 'rules'">
        <p v-if="!settings.current" class="text-xs text-zinc-500">Lendo…</p>
        <form v-else class="flex flex-col gap-3" data-test="installation-git" @submit.prevent="saveRules">
          <p class="text-xs text-zinc-400">
            Valem para todos os projetos desta instalação. A pasta principal de cada repositório fica na branch base: os agentes trabalham em worktrees, e o ambiente não
            recarrega por troca de branch. As branches protegidas só recebem por PR. O prefixo separa as branches deste gateway das de outro no mesmo remoto.
          </p>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">Nome da instalação<input v-model="git.installationName" maxlength="60" class="input" placeholder="gateway do Henrique" /></label>
            <label class="field">Prefixo das branches<input v-model="git.branchPrefix" maxlength="40" class="input font-mono" placeholder="henrique/" /></label>
            <label class="field">Branch base das worktrees<input v-model="git.baseBranch" maxlength="100" class="input font-mono" placeholder="automation" data-test="git-base-branch" /></label>
            <label class="field">Branches protegidas<input v-model="git.protectedBranches" class="input font-mono" placeholder="automation, main" /></label>
          </div>
          <label class="flex items-center gap-2 text-sm text-zinc-300">
            <input v-model="git.lockMainCheckout" type="checkbox" class="accent-emerald-500" />
            Travar a troca de branch na pasta principal do repositório
          </label>
          <p v-if="rulesSaved" class="text-sm text-emerald-300" data-test="git-saved">{{ rulesSaved }}</p>
          <p v-if="rulesFailure" class="text-sm text-rose-300">{{ rulesFailure }}</p>
          <ul v-if="rulesIssues.length" class="list-disc pl-5 text-xs text-rose-300">
            <li v-for="item in rulesIssues" :key="item.field + item.message">{{ item.field ? `${item.field}: ` : '' }}{{ item.message }}</li>
          </ul>
          <SaveFooter submit label="Salvar regras do git" :busy="rulesBusy" />
        </form>
      </template>
    </section>

    <ConfirmDialog
      :open="!!removing"
      :title="`Remover o repositório ${removing?.name}?`"
      :message="`A pasta e as worktrees dele saem do disco desta máquina${removing?.origin ? '; o remoto não muda' : ' — é um git local: o que não foi copiado para outro lugar se perde'}. Commit e mudança que não foram enviados se perdem.`"
      action="Remover"
      :busy="removeBusy"
      @confirm="remove"
      @cancel="removing = undefined"
    />
  </div>
</template>

<style scoped>
@reference '../style.css';

/* O rótulo em cima do campo, como nas outras telas. */
.field {
  @apply flex min-w-0 flex-col gap-1.5 text-sm font-medium text-zinc-300;
}
.input {
  @apply w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
