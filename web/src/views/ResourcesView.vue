<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import BuildTabs from '@/components/BuildTabs.vue'
import { pendingDraft } from '@/lib/builder'
import { api, ApiError } from '@/lib/api'
import { docSlug, GLOBAL_SCOPE, scopeLabel, scopeToProjectId } from '@/lib/guidance'
import { renderMarkdown } from '@/lib/markdown'
import type { IProjectDoc, IResource, TResourceKind } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * SKILLS ou COMMANDS (só admin), uma página para cada (`kind`). ⚖️ O agente só usa o que a guia Recursos dele libera.
 * A skill entra no índice do prompt (nome e descrição) e o agente a carrega com `use_skill`; o command a pessoa dispara
 * com `/nome argumentos`, e o gateway troca pelo texto dele. Os dois levam as specs e ADRs anexadas.
 */
const props = defineProps<{ kind: TResourceKind; id?: string }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()

const KIND: Record<TResourceKind, { title: string; one: string; masc?: boolean; base: string; lead: string; when: string[]; example: string; bodyHint: string; template: string }> = {
  skill: {
    title: 'Skills',
    one: 'skill',
    base: '/skills',
    lead: 'Uma skill ensina o agente a fazer uma coisa bem: passo a passo, formato, cuidados. Ele só a carrega quando precisa.',
    when: ['Um procedimento que se repete (revisar um PR, gerar um relatório)', 'Um formato que tem de sair sempre igual', 'Um conhecimento que só alguns pedidos precisam'],
    example: 'Ex.: "tabela-markdown — Montar tabelas em markdown com cabeçalho e alinhamento".',
    bodyHint: 'Markdown: o que o agente segue quando carregar a skill.',
    template: '# Quando usar\n\n# Passo a passo\n1. \n\n# Cuidados\n- ',
  },
  command: {
    title: 'Commands',
    one: 'command',
    masc: true,
    base: '/commands',
    lead: 'Um command é um pedido pronto: a pessoa digita /nome e o que quiser depois, e o texto salvo é enviado ao agente.',
    when: ['Um pedido que se faz sempre do mesmo jeito', 'Um roteiro longo que ninguém quer redigitar', 'Um ponto de partida padronizado para o time'],
    example: 'Ex.: /resumir relatorio.md → "Resuma relatorio.md em 3 linhas, com os números principais."',
    bodyHint: 'O texto enviado ao agente. Use $ARGUMENTS onde entra o que a pessoa digitar depois de /nome.',
    template: 'Faça … com $ARGUMENTS.',
  },
}

const scope = ref<string>(projects.current ?? GLOBAL_SCOPE)
const list = ref<IResource[]>([])
const docs = ref<IProjectDoc[]>([])
const loadError = ref<string>()
const adding = computed(() => route.name === `${props.kind}-new`)
const info = computed(() => KIND[props.kind])
/** As palavras que concordam com o tipo: "Novo estudo", "Nova spec". */
const g = computed(() => (info.value.masc ? { nova: 'Novo', nenhuma: 'Nenhum', uma: 'um', a: 'o' } : { nova: 'Nova', nenhuma: 'Nenhuma', uma: 'uma', a: 'a' }))

const form = ref({ id: '', description: '', body: '', global: true, project: '', docIds: [] as string[] })
const loaded = ref<IResource>()
const preview = ref(false)
const issues = ref<Record<string, string[]>>({})
const error = ref<string>()
const note = ref<string>()
const busy = ref(false)
const removing = ref(false)

const scopes = computed(() => [{ id: GLOBAL_SCOPE, name: 'Global — todos os projetos' }, ...projects.list.map((project) => ({ id: project.id, name: project.name }))])
const formScope = computed(() => (form.value.global ? GLOBAL_SCOPE : form.value.project))
/** Os documentos que podem ir anexados: os globais e, num recurso de projeto, os do projeto. */
const attachable = computed(() => docs.value.filter((doc) => !doc.projectId || doc.projectId === scopeToProjectId(formScope.value)))
const dirty = computed(() => {
  const resource = loaded.value
  if (!resource) return true
  return (
    form.value.description !== resource.description || form.value.body !== resource.body || formScope.value !== (resource.projectId ?? GLOBAL_SCOPE) || form.value.docIds.join() !== resource.docIds.join()
  )
})

onMounted(async () => {
  if (!auth.isAdmin) return
  if (!projects.loaded) await projects.load().catch(() => undefined)
  await loadList()
})
watch(scope, () => void loadList())
watch(() => props.kind, () => void loadList())
watch(formScope, () => void loadDocs(), { immediate: true })

watch(
  () => [props.id, adding.value, props.kind] as const,
  async ([id, isNew, kind]) => {
    issues.value = {}
    error.value = undefined
    note.value = undefined
    preview.value = false
    if (isNew) {
      loaded.value = undefined
      form.value = { id: '', description: '', body: KIND[kind].template, global: scope.value === GLOBAL_SCOPE, project: scope.value === GLOBAL_SCOPE ? (projects.current ?? '') : scope.value, docIds: [] }
      applyDraft(kind)
      return
    }
    if (!id) return
    try {
      const resource = await api<IResource>(`/resources/${encodeURIComponent(id)}`)
      if (resource.kind !== kind) return void router.replace(`${KIND[resource.kind].base}/${resource.id}`)
      loaded.value = resource
      form.value = { id: resource.id, description: resource.description, body: resource.body, global: !resource.projectId, project: resource.projectId ?? projects.current ?? '', docIds: [...resource.docIds] }
      applyDraft(kind, resource.id)
    } catch (failure) {
      loaded.value = undefined
      error.value = describe(failure)
    }
  },
  { immediate: true },
)

/**
 * O rascunho do construtor ("Abrir no editor"): preenche o formulário SEM salvar, e é consumido. Só o do mesmo tipo e,
 * na edição, o do mesmo id.
 */
function applyDraft(kind: TResourceKind, id?: string) {
  const draft = pendingDraft.value
  if (!draft || draft.kind !== kind || (id && draft.id !== id)) return
  pendingDraft.value = undefined
  form.value = {
    id: id ?? draft.id,
    description: draft.description,
    body: draft.body,
    global: !draft.projectId,
    project: draft.projectId ?? projects.current ?? '',
    docIds: [...draft.docIds],
  }
  note.value = 'Rascunho do construtor aplicado: revise e salve.'
}

async function loadList() {
  loadError.value = undefined
  try {
    list.value = await api<IResource[]>('/resources', { query: { project: scope.value, kind: props.kind } })
  } catch (failure) {
    loadError.value = describe(failure)
  }
}

async function loadDocs() {
  const project = scopeToProjectId(formScope.value)
  const [globals, local] = await Promise.all([
    api<IProjectDoc[]>('/docs', { query: { project: GLOBAL_SCOPE } }).catch(() => []),
    project ? api<IProjectDoc[]>('/docs', { query: { project } }).catch(() => []) : Promise.resolve([]),
  ])
  docs.value = [...local, ...globals]
}

function toggleDoc(id: string) {
  form.value.docIds = form.value.docIds.includes(id) ? form.value.docIds.filter((item) => item !== id) : [...form.value.docIds, id]
}

function slug() {
  if (!form.value.id && form.value.description) form.value.id = docSlug(form.value.description).split('-').slice(0, 4).join('-')
}

async function save() {
  issues.value = {}
  error.value = undefined
  note.value = undefined
  busy.value = true
  // Um doc de outro projeto não vai junto quando o escopo muda.
  const docIds = form.value.docIds.filter((id) => attachable.value.some((doc) => doc.id === id))
  const body = { description: form.value.description, body: form.value.body, projectId: scopeToProjectId(formScope.value), docIds }
  try {
    if (adding.value) {
      const created = await api<IResource>('/resources', { method: 'POST', body: { id: form.value.id, kind: props.kind, ...body } })
      scope.value = created.projectId ?? GLOBAL_SCOPE
      await loadList()
      await router.push(`${info.value.base}/${created.id}`)
    } else {
      loaded.value = await api<IResource>(`/resources/${encodeURIComponent(form.value.id)}`, { method: 'PUT', body })
      form.value.docIds = [...loaded.value.docIds]
      note.value = 'Salvo. Vale para as próximas conversas.'
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
    await api(`/resources/${encodeURIComponent(form.value.id)}`, { method: 'DELETE' })
    removing.value = false
    await loadList()
    await router.push(info.value.base)
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
    <p class="font-medium text-zinc-200">Só quem administra pode gerenciar {{ info.title }}.</p>
  </div>

  <MasterDetail v-else :open="!!id || adding" :back-to="info.base" :back-label="info.title" :title="adding ? `${g.nova} ${info.one}` : loaded?.id">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-3">
        <h1 class="text-xl font-semibold">{{ info.title }}</h1>
        <RouterLink :to="`${info.base}/new`" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" :title="`${g.nova} ${info.one}`"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <BuildTabs :kind="kind" active="list" class="px-3 pb-2" />
      <div class="px-3 pb-2">
        <select v-model="scope" class="input w-full py-1.5 text-sm" aria-label="Escopo">
          <option v-for="item in scopes" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </div>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <p v-else-if="!list.length" class="px-4 py-2 text-sm text-zinc-500">{{ g.nenhuma }} {{ info.one }} em {{ scopeLabel(scope, projects.list) }}.</p>
      <RouterLink v-for="resource in list" :key="resource.id" :to="`${info.base}/${resource.id}`" class="mx-2 block rounded-xl px-3 py-2" :class="resource.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'">
        <span class="block truncate font-mono text-sm">{{ kind === 'command' ? '/' : '' }}{{ resource.id }}</span>
        <span class="block truncate text-xs text-zinc-500">{{ resource.description }}<template v-if="resource.docIds.length"> · {{ resource.docIds.length }} doc(s)</template></span>
      </RouterLink>
    </template>

    <template #detail>
      <form v-if="adding || loaded" class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="save">
        <h2 class="font-mono text-lg font-semibold">{{ adding ? `${g.nova} ${info.one}` : `${kind === 'command' ? '/' : ''}${loaded?.id}` }}</h2>
        <label class="field">
          Descrição
          <input v-model="form.description" required maxlength="300" class="input" :placeholder="kind === 'command' ? 'Resume um arquivo em 3 linhas' : 'Montar tabelas em markdown'" @blur="slug" />
          <small class="hint">Uma linha: diz quando usar.</small>
          <small v-for="m in issues.description" :key="m" class="error">{{ m }}</small>
        </label>
        <label class="field">
          Identificador
          <input v-model="form.id" :disabled="!adding" required pattern="[a-z0-9][a-z0-9-]{1,47}" class="input font-mono disabled:opacity-60" :placeholder="kind === 'command' ? 'resumir' : 'tabela-markdown'" />
          <small class="hint">{{ kind === 'command' ? 'É o /nome que a pessoa digita.' : 'Identifica a skill.' }} Não muda depois.</small>
          <small v-for="m in issues.id" :key="m" class="error">{{ m }}</small>
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
            <button type="button" class="btn btn-sm" :class="!preview ? 'btn-secondary' : 'btn-ghost'" @click="preview = false">{{ kind === 'command' ? 'Texto' : 'Markdown' }}</button>
            <button type="button" class="btn btn-sm" :class="preview ? 'btn-secondary' : 'btn-ghost'" @click="preview = true">Prévia</button>
          </div>
          <textarea v-if="!preview" v-model="form.body" required rows="14" class="input font-mono text-[13px] leading-relaxed" :aria-label="info.bodyHint" />
          <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
          <div v-else class="prose-agent min-h-[14rem] rounded-xl border border-zinc-800 p-4 text-sm break-words" v-html="renderMarkdown(form.body)" />
          <small class="hint">{{ info.bodyHint }}</small>
          <small v-for="m in issues.body" :key="m" class="error">{{ m }}</small>
        </div>

        <div class="flex flex-col gap-1.5 rounded-xl border border-zinc-800 p-3">
          <p class="text-sm font-medium text-zinc-200">Specs e ADRs anexadas <span class="text-xs font-normal text-zinc-500">— vão junto quando {{ kind === 'command' ? 'o command é usado' : 'a skill é carregada' }}</span></p>
          <p v-if="!attachable.length" class="text-xs text-zinc-500">Nenhum documento {{ form.global ? 'global' : 'global ou deste projeto' }}. <RouterLink to="/specs/new" class="text-emerald-400 underline underline-offset-2">Criar uma spec</RouterLink>.</p>
          <label v-for="doc in attachable" :key="doc.id" class="flex items-center gap-2 text-sm">
            <input type="checkbox" class="accent-emerald-500" :checked="form.docIds.includes(doc.id)" @change="toggleDoc(doc.id)" />
            <span class="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400 uppercase">{{ doc.kind }}</span>
            <span class="min-w-0 truncate">{{ doc.title }}</span>
            <span class="ml-auto shrink-0 text-xs text-zinc-500 tabular-nums">≈ {{ (doc.tokens ?? 0).toLocaleString('pt-BR') }} tokens</span>
          </label>
          <small v-for="m in issues.docIds" :key="m" class="error">{{ m }}</small>
        </div>

        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
        <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
        <div class="flex gap-2">
          <button type="submit" :disabled="busy || !dirty" class="btn btn-primary">{{ adding ? 'Criar' : 'Salvar' }}</button>
          <RouterLink v-if="adding" :to="info.base" class="btn btn-ghost">Cancelar</RouterLink>
          <button v-else type="button" class="btn btn-danger ml-auto" @click="removing = true">Apagar</button>
        </div>
      </form>
      <p v-else-if="error" class="mx-auto max-w-3xl text-sm text-rose-300">{{ error }}</p>
      <section v-else class="mx-auto flex max-w-2xl flex-col gap-3 text-sm text-zinc-300">
        <h2 class="text-lg font-semibold text-zinc-100">O que é {{ g.uma }} {{ info.one }}</h2>
        <p>{{ info.lead }}</p>
        <div>
          <p class="mb-1 font-medium text-zinc-200">Quando criar uma</p>
          <ul class="list-disc pl-5 text-zinc-400">
            <li v-for="item in info.when" :key="item">{{ item }}</li>
          </ul>
        </div>
        <p class="text-zinc-400">{{ info.example }}</p>
        <p class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400">
          Quem usa: todo agente do escopo. A guia <strong class="text-zinc-300">Recursos</strong> de um agente pode restringir.
        </p>
        <div><RouterLink :to="`${info.base}/new`" class="btn btn-primary">{{ g.nova }} {{ info.one }}</RouterLink></div>
      </section>
    </template>
  </MasterDetail>

  <ConfirmDialog :open="removing" :title="`Apagar ${g.a} ${info.one}?`" :message="`Os agentes deixam de usar ${form.id} na hora.`" :busy="busy" @confirm="confirmRemove" @cancel="removing = false" />
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
