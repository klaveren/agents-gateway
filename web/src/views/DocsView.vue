<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import { api, ApiError } from '@/lib/api'
import { docSlug, GLOBAL_SCOPE, scopeLabel, scopeToProjectId } from '@/lib/guidance'
import { renderMarkdown } from '@/lib/markdown'
import type { IProjectDoc, TDocKind } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * SPECS E ADRs (só admin): documentos em markdown que os agentes consultam.
 * ⚖️ A conversa recebe só o índice (id, título, resumo) — os globais e os do projeto dela — e o agente lê o
 * documento inteiro com `read_doc` quando precisa. O status de uma ADR fica no próprio texto.
 */
const props = defineProps<{ id?: string }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()

const KIND_LABEL: Record<TDocKind, string> = { spec: 'Specs', adr: 'ADRs' }
const TEMPLATE: Record<TDocKind, string> = {
  spec: '# Objetivo\n\n# Requisitos\n- \n\n# Fora do escopo\n- ',
  adr: '**Status:** Proposta\n\n# Contexto\n\n# Decisão\n\n# Consequências\n- ',
}

const scope = ref<string>(projects.current ?? GLOBAL_SCOPE)
const kind = ref<TDocKind>('spec')
const list = ref<IProjectDoc[]>([])
const loadError = ref<string>()
const adding = computed(() => route.name === 'doc-new')

const form = ref({ id: '', kind: 'spec' as TDocKind, title: '', summary: '', body: '', global: true, project: '' })
const loaded = ref<IProjectDoc>()
const preview = ref(false)
const issues = ref<Record<string, string[]>>({})
const error = ref<string>()
const note = ref<string>()
const busy = ref(false)
const removing = ref(false)

const scopes = computed(() => [{ id: GLOBAL_SCOPE, name: 'Global — todos os projetos' }, ...projects.list.map((project) => ({ id: project.id, name: project.name }))])
const shown = computed(() => list.value.filter((doc) => doc.kind === kind.value))
const counts = computed(() => ({ spec: list.value.filter((doc) => doc.kind === 'spec').length, adr: list.value.filter((doc) => doc.kind === 'adr').length }))
const formScope = computed(() => (form.value.global ? GLOBAL_SCOPE : form.value.project))
const dirty = computed(() => {
  const doc = loaded.value
  if (!doc) return true
  return (
    form.value.kind !== doc.kind ||
    form.value.title !== doc.title ||
    form.value.summary !== doc.summary ||
    form.value.body !== (doc.body ?? '') ||
    formScope.value !== (doc.projectId ?? GLOBAL_SCOPE)
  )
})

onMounted(async () => {
  if (!auth.isAdmin) return
  if (!projects.loaded) await projects.load().catch(() => undefined)
  await loadList()
})
watch(scope, () => void loadList())

watch(
  () => [props.id, adding.value] as const,
  async ([id, isNew]) => {
    issues.value = {}
    error.value = undefined
    note.value = undefined
    preview.value = false
    if (isNew) {
      loaded.value = undefined
      form.value = { id: '', kind: kind.value, title: '', summary: '', body: TEMPLATE[kind.value], global: scope.value === GLOBAL_SCOPE, project: scope.value === GLOBAL_SCOPE ? (projects.current ?? '') : scope.value }
      return
    }
    if (!id) return
    try {
      const doc = await api<IProjectDoc>(`/docs/${encodeURIComponent(id)}`)
      loaded.value = doc
      form.value = { id: doc.id, kind: doc.kind, title: doc.title, summary: doc.summary, body: doc.body ?? '', global: !doc.projectId, project: doc.projectId ?? projects.current ?? '' }
    } catch (failure) {
      loaded.value = undefined
      error.value = describe(failure)
    }
  },
  { immediate: true },
)

async function loadList() {
  loadError.value = undefined
  try {
    list.value = await api<IProjectDoc[]>('/docs', { query: { project: scope.value } })
  } catch (failure) {
    loadError.value = describe(failure)
  }
}

function slug() {
  if (!form.value.id && form.value.title) form.value.id = docSlug(form.value.title)
}

async function save() {
  issues.value = {}
  error.value = undefined
  note.value = undefined
  busy.value = true
  const body = { kind: form.value.kind, title: form.value.title, summary: form.value.summary, body: form.value.body, projectId: scopeToProjectId(formScope.value) }
  try {
    if (adding.value) {
      const created = await api<IProjectDoc>('/docs', { method: 'POST', body: { id: form.value.id, ...body } })
      scope.value = created.projectId ?? GLOBAL_SCOPE
      kind.value = created.kind
      await loadList()
      await router.push(`/docs/${created.id}`)
    } else {
      loaded.value = await api<IProjectDoc>(`/docs/${encodeURIComponent(form.value.id)}`, { method: 'PUT', body })
      note.value = 'Documento salvo. Vale para as conversas que começarem agora.'
      await loadList()
    }
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) issues.value = failure.fieldIssues
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

async function confirmRemove() {
  busy.value = true
  try {
    await api(`/docs/${encodeURIComponent(form.value.id)}`, { method: 'DELETE' })
    removing.value = false
    await loadList()
    await router.push('/docs')
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra cadastra specs e ADRs.</p>
  </div>

  <MasterDetail v-else :open="!!id || adding" back-to="/docs" back-label="Specs e ADRs" :title="adding ? 'Novo documento' : loaded?.title">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-1">
        <h1 class="text-xl font-semibold">Specs e ADRs</h1>
        <RouterLink to="/docs/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Novo documento"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <p class="px-4 pb-2 text-xs text-zinc-500">A conversa recebe o índice (título e resumo) dos globais e dos do projeto dela; o agente lê o documento inteiro quando precisa.</p>
      <div class="px-4 pb-2">
        <select v-model="scope" class="input py-1.5 text-sm" aria-label="Escopo">
          <option v-for="item in scopes" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </div>
      <div class="flex gap-1.5 px-4 pb-2">
        <button
          v-for="value in ['spec', 'adr'] as const"
          :key="value"
          type="button"
          class="rounded-full border px-3 py-1 text-xs"
          :class="kind === value ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'"
          @click="kind = value"
        >
          {{ KIND_LABEL[value] }} <span class="text-zinc-500">{{ counts[value] }}</span>
        </button>
      </div>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <p v-else-if="!shown.length" class="px-4 py-2 text-sm text-zinc-500">Nenhuma {{ kind === 'spec' ? 'spec' : 'ADR' }} em {{ scopeLabel(scope, projects.list) }}.</p>
      <RouterLink v-for="doc in shown" :key="doc.id" :to="`/docs/${doc.id}`" class="mx-2 block rounded-xl px-3 py-2" :class="doc.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'">
        <span class="block truncate text-sm font-medium">{{ doc.title }}</span>
        <span class="block truncate text-xs text-zinc-500">{{ doc.id }}<template v-if="doc.summary"> · {{ doc.summary }}</template></span>
      </RouterLink>
    </template>

    <template #detail>
      <form v-if="adding || loaded" class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="save">
        <h2 class="text-lg font-semibold">{{ adding ? 'Novo documento' : loaded?.title }}</h2>
        <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label class="field">Título<input v-model="form.title" required maxlength="160" class="input" placeholder="Autenticação por sessão" @blur="slug" /><small v-for="m in issues.title" :key="m" class="error">{{ m }}</small></label>
          <label class="field">
            Tipo
            <select v-model="form.kind" class="input">
              <option value="spec">Spec</option>
              <option value="adr">ADR</option>
            </select>
          </label>
        </div>
        <label class="field">
          Id
          <input v-model="form.id" :disabled="!adding" required pattern="[a-z0-9][a-z0-9-]{1,63}" class="input font-mono disabled:opacity-60" placeholder="autenticacao-por-sessao" />
          <small class="hint">É por ele que o agente pede o documento (<code>read_doc</code>). Não muda depois.</small>
          <small v-for="m in issues.id" :key="m" class="error">{{ m }}</small>
        </label>
        <label class="field">
          Resumo
          <input v-model="form.summary" maxlength="300" class="input" placeholder="Uma linha: o que o documento cobre" />
          <small class="hint">Vai no índice de cada conversa: é o que faz o agente saber quando ler.</small>
          <small v-for="m in issues.summary" :key="m" class="error">{{ m }}</small>
        </label>
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <label class="flex items-center gap-2"><input v-model="form.global" type="checkbox" class="accent-emerald-500" /> Global (todos os projetos)</label>
          <select v-if="!form.global" v-model="form.project" required class="input w-auto py-1.5 text-sm" aria-label="Projeto">
            <option v-for="project in projects.list" :key="project.id" :value="project.id">{{ project.name }}</option>
          </select>
          <small v-for="m in issues.projectId" :key="m" class="error">{{ m }}</small>
        </div>

        <div class="flex flex-col gap-1">
          <div class="flex gap-1 text-xs">
            <button type="button" class="rounded-full px-3 py-1" :class="!preview ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'" @click="preview = false">Markdown</button>
            <button type="button" class="rounded-full px-3 py-1" :class="preview ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'" @click="preview = true">Prévia</button>
          </div>
          <textarea v-if="!preview" v-model="form.body" required rows="18" class="input font-mono text-[13px] leading-relaxed" aria-label="Conteúdo em markdown" />
          <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
          <div v-else class="prose-agent min-h-[18rem] rounded-xl border border-zinc-800 p-4 text-sm break-words" v-html="renderMarkdown(form.body)" />
          <small v-for="m in issues.body" :key="m" class="error">{{ m }}</small>
        </div>

        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
        <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
        <div class="flex gap-2">
          <button type="submit" :disabled="busy || !dirty" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{{ adding ? 'Criar' : 'Salvar' }}</button>
          <RouterLink v-if="adding" to="/docs" class="rounded-full px-4 py-2 text-sm hover:bg-zinc-800">Cancelar</RouterLink>
          <button v-else type="button" class="ml-auto rounded-full px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/10" @click="removing = true">Apagar</button>
        </div>
      </form>
      <p v-else-if="error" class="mx-auto max-w-3xl text-sm text-rose-300">{{ error }}</p>
      <div v-else class="grid h-full place-items-center text-center text-sm text-zinc-500">Escolha um documento ou crie um novo.</div>
    </template>
  </MasterDetail>

  <ConfirmDialog
    :open="removing"
    title="Apagar o documento?"
    :message="`${form.title} sai do índice das conversas novas.`"
    :busy="busy"
    @confirm="confirmRemove"
    @cancel="removing = false"
  />
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
