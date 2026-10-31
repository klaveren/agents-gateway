<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import BuildTabs from '@/components/BuildTabs.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import HistoryPanel from '@/components/HistoryPanel.vue'
import HistoryTabs from '@/components/HistoryTabs.vue'
import { api, ApiError } from '@/lib/api'
import { sizeHint } from '@/lib/format'
import { pendingDraft } from '@/lib/builder'
import { attachableDocs, attachedRefs, attachmentsChanged, docSlug, GLOBAL_SCOPE, scopeLabel, scopeToProjectId, setAttachMode, type TAttachMode } from '@/lib/guidance'
import type { IRestoreResult } from '@/lib/catalogHistory'
import { renderMarkdown } from '@/lib/markdown'
import type { IProjectDoc, TDocKind } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useAgentsStore } from '@/stores/agents'
import { useProjectsStore } from '@/stores/projects'

/**
 * SPECS ou ADRs (só admin), uma página para cada (`kind`): documentos em markdown que os agentes consultam.
 * ⚖️ A conversa recebe só o índice (id, título, resumo) — os globais e os do projeto dela — e o agente lê o
 * documento inteiro com `read_doc` quando precisa. O status de uma ADR fica no próprio texto.
 * ⚖️ Relação com outro documento (spec que cita spec, ADR → spec) é ANEXO, feito aqui — não caminho citado no texto. O
 * anexado vai junto quando o documento é lido: inteiro ou por referência, como no anexo de skill.
 */
const props = defineProps<{ kind: TDocKind; id?: string }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const agents = useAgentsStore()

/** O que é cada tipo, para quem cadastra: a página explica antes de pedir o texto. */
const KIND: Record<TDocKind, { title: string; one: string; masc?: boolean; base: string; lead: string; when: string[]; example: string; placeholder: string }> = {
  spec: {
    title: 'Specs',
    one: 'spec',
    base: '/specs',
    lead: 'Uma spec define como algo deve ser: requisitos, formatos e critérios de aceite. O agente a segue ao trabalhar.',
    when: ['Formato de um arquivo, relatório ou resposta', 'Contrato de uma API ou de uma integração', 'Critérios para dar uma tarefa por pronta'],
    example: 'Ex.: "Nomes de arquivo — todo arquivo novo usa AAAA-MM-DD-assunto.md".',
    placeholder: 'Nomes de arquivo',
  },
  adr: {
    title: 'ADRs',
    one: 'ADR',
    base: '/adrs',
    lead: 'Uma ADR registra uma decisão: contexto, o que foi decidido e as consequências. Impede o agente de desfazer o que foi escolhido de propósito.',
    when: ['Uma escolha de tecnologia ou de arquitetura', 'Um caminho descartado, e por quê', 'Uma decisão que troca outra (diga qual no texto)'],
    example: 'O status vai no próprio texto: Proposta, Aceita, Substituída por…',
    placeholder: 'Autenticação por sessão',
  },
  knowledge: {
    title: 'Conhecimento',
    one: 'estudo',
    masc: true,
    base: '/knowledge',
    lead: 'Um estudo resume um tema a partir de fontes confiáveis: o que é, o problema que resolve e onde se aplica aqui. É a base antes de escrever spec, skill ou ADR.',
    when: ['Antes de criar uma spec, skill ou ADR de um tema novo', 'Uma tecnologia ou padrão que o time vai adotar', 'Um conceito que vários agentes precisam entender igual'],
    example: 'Ex.: "Feature flags — tipos, ciclo de vida e custos". A guia Construir pesquisa na web por você.',
    placeholder: 'Feature flags',
  },
}
const TEMPLATE: Record<TDocKind, string> = {
  spec: '# Objetivo\n\n# Requisitos\n- \n\n# Fora do escopo\n- ',
  adr: '**Status:** Proposta\n\n# Contexto\n\n# Decisão\n\n# Consequências\n- ',
  knowledge: '# Tema\n\n<definição>\n\n## O problema que resolve\n- \n\n## Componentes\n- \n\n## Onde se aplica aqui\n\n## Lacunas\n- \n\n## Fontes\n- ',
}

const scope = ref<string>(projects.current ?? GLOBAL_SCOPE)
const list = ref<IProjectDoc[]>([])
const loadError = ref<string>()
const adding = computed(() => route.name === `${props.kind}-new`)
const info = computed(() => KIND[props.kind])
/** As palavras que concordam com o tipo: "Novo estudo", "Nova spec". */
const g = computed(() => (info.value.masc ? { nova: 'Novo', nenhuma: 'Nenhum', uma: 'um', a: 'o' } : { nova: 'Nova', nenhuma: 'Nenhuma', uma: 'uma', a: 'a' }))

const form = ref({ id: '', kind: 'spec' as TDocKind, title: '', summary: '', body: '', global: true, project: '', docIds: [] as string[], docRefs: [] as string[] })
/** Os documentos que este pode anexar: os globais e os do projeto do formulário (a lista não segue o filtro de escopo). */
const docs = ref<IProjectDoc[]>([])
/** A guia da edição: o formulário ou o histórico (`#historico` no endereço abre nele). */
const tab = ref<'edit' | 'history'>(route.hash === '#historico' ? 'history' : 'edit')
/** Muda depois de restaurar uma versão: relê o item. */
const reloadKey = ref(0)
const loaded = ref<IProjectDoc>()
const preview = ref(false)
const issues = ref<Record<string, string[]>>({})
const error = ref<string>()
const note = ref<string>()
const busy = ref(false)
const removing = ref(false)

const scopes = computed(() => [{ id: GLOBAL_SCOPE, name: 'Global — todos os projetos' }, ...projects.list.map((project) => ({ id: project.id, name: project.name }))])
const shown = computed(() => list.value.filter((doc) => doc.kind === props.kind))
const formScope = computed(() => (form.value.global ? GLOBAL_SCOPE : form.value.project))
const attachable = computed(() => attachableDocs(docs.value, scopeToProjectId(formScope.value), form.value.id || undefined))
const dirty = computed(() => {
  const doc = loaded.value
  if (!doc) return true
  return (
    form.value.title !== doc.title ||
    form.value.summary !== doc.summary ||
    form.value.body !== (doc.body ?? '') ||
    formScope.value !== (doc.projectId ?? GLOBAL_SCOPE) ||
    attachmentsChanged(form.value, doc)
  )
})

onMounted(async () => {
  if (!auth.isAdmin) return
  if (!projects.loaded) await projects.load().catch(() => undefined)
  // Os nomes dos agentes do selo "carregada em".
  if (!agents.loaded) void agents.load().catch(() => undefined)
  await loadList()
})
watch(scope, () => void loadList())
watch(formScope, () => void loadDocs(), { immediate: true })

watch(
  () => [props.id, adding.value, props.kind, reloadKey.value] as const,
  async ([id, isNew, kind]) => {
    issues.value = {}
    error.value = undefined
    note.value = undefined
    preview.value = false
    if (isNew) {
      loaded.value = undefined
      form.value = {
        id: '',
        kind,
        title: '',
        summary: '',
        body: TEMPLATE[kind],
        global: scope.value === GLOBAL_SCOPE,
        project: scope.value === GLOBAL_SCOPE ? (projects.current ?? '') : scope.value,
        docIds: [],
        docRefs: [],
      }
      applyDraft(kind)
      return
    }
    if (!id) return
    try {
      const doc = await api<IProjectDoc>(`/docs/${encodeURIComponent(id)}`)
      // O endereço é da outra página (uma ADR aberta em /specs): vai para a certa.
      if (doc.kind !== kind) return void router.replace(`${KIND[doc.kind].base}/${doc.id}`)
      loaded.value = doc
      form.value = {
        id: doc.id,
        kind: doc.kind,
        title: doc.title,
        summary: doc.summary,
        body: doc.body ?? '',
        global: !doc.projectId,
        project: doc.projectId ?? projects.current ?? '',
        docIds: [...(doc.docIds ?? [])],
        docRefs: [...(doc.docRefs ?? [])],
      }
      applyDraft(kind, doc.id)
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
function applyDraft(kind: TDocKind, id?: string) {
  const draft = pendingDraft.value
  if (!draft || draft.kind !== kind || (id && draft.id !== id)) return
  pendingDraft.value = undefined
  form.value = {
    id: id ?? draft.id,
    kind,
    title: draft.title,
    summary: draft.summary,
    body: draft.body,
    global: !draft.projectId,
    project: draft.projectId ?? projects.current ?? '',
    docIds: [...draft.docIds],
    docRefs: [...draft.docRefs],
  }
  note.value = 'Rascunho do construtor aplicado: revise e salve.'
}

async function loadList() {
  loadError.value = undefined
  try {
    list.value = await api<IProjectDoc[]>('/docs', { query: { project: scope.value } })
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

function attachMode(id: string): TAttachMode {
  return form.value.docRefs.includes(id) ? 'reference' : 'inline'
}

function setMode(id: string, mode: TAttachMode) {
  form.value.docRefs = setAttachMode(form.value.docRefs, id, mode)
}

function slug() {
  if (!form.value.id && form.value.title) form.value.id = docSlug(form.value.title)
}

async function save() {
  issues.value = {}
  error.value = undefined
  note.value = undefined
  busy.value = true
  // Um doc de outro projeto não vai junto quando o escopo muda.
  const docIds = form.value.docIds.filter((id) => attachable.value.some((doc) => doc.id === id))
  const body = {
    kind: form.value.kind,
    title: form.value.title,
    summary: form.value.summary,
    body: form.value.body,
    projectId: scopeToProjectId(formScope.value),
    docIds,
    docRefs: attachedRefs(docIds, form.value.docRefs),
  }
  try {
    if (adding.value) {
      const created = await api<IProjectDoc>('/docs', { method: 'POST', body: { id: form.value.id, ...body } })
      scope.value = created.projectId ?? GLOBAL_SCOPE
      await loadList()
      await router.push(`${info.value.base}/${created.id}`)
    } else {
      loaded.value = await api<IProjectDoc>(`/docs/${encodeURIComponent(form.value.id)}`, { method: 'PUT', body })
      form.value.docIds = [...(loaded.value.docIds ?? [])]
      form.value.docRefs = [...(loaded.value.docRefs ?? [])]
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

/** Restaurou uma versão: relê o item e a lista; se a versão era a de antes de existir, o item sumiu. */
function restored(result: IRestoreResult) {
  void loadList()
  if (!result.exists) return void router.push(info.value.base)
  reloadKey.value++
}

// Outro item (ou o mesmo pelo link com `#historico`): a guia segue o endereço.
watch(
  () => props.id,
  () => (tab.value = route.hash === '#historico' ? 'history' : 'edit'),
)

async function confirmRemove() {
  busy.value = true
  try {
    await api(`/docs/${encodeURIComponent(form.value.id)}`, { method: 'DELETE' })
    removing.value = false
    await loadList()
    await router.push(info.value.base)
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

/** Quem carrega a spec inteira, para o selo: "XPTO, agente Dev". */
function loadedLabel(doc: IProjectDoc): string {
  const projectsIn = (doc.loadedIn?.projects ?? []).map((id) => scopeLabel(id, projects.list))
  const agentsIn = (doc.loadedIn?.agents ?? []).map((id) => `agente ${agents.byId.get(id)?.name ?? id}`)
  return [...projectsIn, ...agentsIn].join(', ')
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra pode gerenciar {{ info.title }}.</p>
  </div>

  <MasterDetail v-else :open="!!id || adding" :back-to="info.base" :back-label="info.title" :title="adding ? `${g.nova} ${info.one}` : loaded?.title">
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
      <p v-else-if="!shown.length" class="px-4 py-2 text-sm text-zinc-500">{{ g.nenhuma }} {{ info.one }} em {{ scopeLabel(scope, projects.list) }}.</p>
      <RouterLink v-for="doc in shown" :key="doc.id" :to="`${info.base}/${doc.id}`" class="mx-2 block rounded-xl px-3 py-2" :class="doc.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'">
        <span class="block truncate text-sm font-medium">{{ doc.title }}</span>
        <span class="block truncate text-xs text-zinc-500">{{ doc.id }}<template v-if="doc.summary"> · {{ doc.summary }}</template></span>
        <span v-if="loadedLabel(doc)" class="mt-1 inline-block max-w-full truncate rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">usada em {{ loadedLabel(doc) }}</span>
      </RouterLink>
    </template>

    <template #detail>
      <div v-if="!adding && loaded" class="mx-auto mb-4 max-w-3xl"><HistoryTabs v-model="tab" edit-label="Editar" /></div>
      <form v-if="adding || (loaded && tab === 'edit')" class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="save">
        <h2 class="text-lg font-semibold">{{ adding ? `${g.nova} ${info.one}` : loaded?.title }}</h2>
        <label class="field">Título<input v-model="form.title" required maxlength="160" class="input" :placeholder="info.placeholder" @blur="slug" /><small v-for="m in issues.title" :key="m" class="error">{{ m }}</small></label>
        <label class="field">
          Identificador
          <input v-model="form.id" :disabled="!adding" required pattern="[a-z0-9][a-z0-9-]{1,63}" class="input font-mono disabled:opacity-60" placeholder="autenticacao-por-sessao" />
          <small class="hint">Identifica o documento. Não muda depois.</small>
          <small v-for="m in issues.id" :key="m" class="error">{{ m }}</small>
        </label>
        <label class="field">
          Resumo
          <input v-model="form.summary" maxlength="300" class="input" placeholder="Uma linha: o que o documento cobre" />
          <small class="hint">É o que o agente lê para saber quando usar este documento.</small>
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
            <button type="button" class="btn btn-sm" :class="!preview ? 'btn-secondary' : 'btn-ghost'" @click="preview = false">Markdown</button>
            <button type="button" class="btn btn-sm" :class="preview ? 'btn-secondary' : 'btn-ghost'" @click="preview = true">Prévia</button>
          </div>
          <textarea v-if="!preview" v-model="form.body" required rows="18" class="input font-mono text-[13px] leading-relaxed" aria-label="Conteúdo em markdown" />
          <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
          <div v-else class="prose-agent min-h-[18rem] rounded-xl border border-zinc-800 p-4 text-sm break-words" v-html="renderMarkdown(form.body)" />
          <small v-if="form.body" class="hint">{{ sizeHint(form.body, 'quando lido') }}</small>
          <small v-for="m in issues.body" :key="m" class="error">{{ m }}</small>
        </div>

        <div class="flex flex-col gap-1.5 rounded-xl border border-zinc-800 p-3">
          <p class="text-sm font-medium text-zinc-200">Documentos anexados <span class="text-xs font-normal text-zinc-500">— vão junto quando este documento é lido</span></p>
          <p v-if="!attachable.length" class="text-xs text-zinc-500">Nenhum outro documento {{ form.global ? 'global' : 'global ou deste projeto' }}.</p>
          <div v-for="doc in attachable" :key="doc.id" class="flex flex-wrap items-center gap-2 text-sm">
            <label class="flex min-w-0 flex-1 items-center gap-2">
              <input type="checkbox" class="accent-emerald-500" :checked="form.docIds.includes(doc.id)" @change="toggleDoc(doc.id)" />
              <span class="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400 uppercase">{{ doc.kind }}</span>
              <span class="min-w-0 truncate">{{ doc.title }}</span>
              <span class="ml-auto shrink-0 text-xs text-zinc-500 tabular-nums">≈ {{ (doc.tokens ?? 0).toLocaleString('pt-BR') }} tokens</span>
            </label>
            <select
              v-if="form.docIds.includes(doc.id)"
              :value="attachMode(doc.id)"
              class="input w-auto py-1 text-xs"
              :aria-label="`Como ${doc.title} vai junto`"
              @change="setMode(doc.id, ($event.target as HTMLSelectElement).value as TAttachMode)"
            >
              <option value="inline">inteiro</option>
              <option value="reference">por referência</option>
            </select>
          </div>
          <small class="hint">
            A relação com outro documento (spec que cita spec, ADR que aponta a spec) é anexo aqui, não caminho no texto. Inteiro: o texto vai junto. Por referência: vão só id, título e
            tamanho, e o agente lê com read_doc se precisar. O anexo de um anexo vai sempre por referência.
          </small>
          <small v-for="m in issues.docIds" :key="m" class="error">{{ m }}</small>
          <small v-for="m in issues.docRefs" :key="m" class="error">{{ m }}</small>
        </div>

        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
        <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
        <div class="flex gap-2">
          <button type="submit" :disabled="busy || !dirty" class="btn btn-primary">{{ adding ? 'Criar' : 'Salvar' }}</button>
          <RouterLink v-if="adding" :to="info.base" class="btn btn-ghost">Cancelar</RouterLink>
          <button v-else type="button" class="btn btn-danger ml-auto" @click="removing = true">Apagar</button>
        </div>
      </form>
      <section v-else-if="loaded && tab === 'history'" class="mx-auto flex max-w-3xl flex-col gap-3">
        <h2 class="text-lg font-semibold">{{ loaded.title }}</h2>
        <HistoryPanel :kind="kind" :id="loaded.id" @restored="restored" />
      </section>
      <p v-else-if="error" class="mx-auto max-w-3xl text-sm text-rose-300">{{ error }}</p>
      <section v-else class="mx-auto flex max-w-2xl flex-col gap-3 text-sm text-zinc-300">
        <h2 class="text-lg font-semibold text-zinc-100">O que é {{ g.uma }} {{ info.one }}</h2>
        <p>{{ info.lead }}</p>
        <div>
          <p class="mb-1 font-medium text-zinc-200">Quando escrever uma</p>
          <ul class="list-disc pl-5 text-zinc-400">
            <li v-for="item in info.when" :key="item">{{ item }}</li>
          </ul>
        </div>
        <p class="text-zinc-400">{{ info.example }}</p>
        <p class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400">
          Como o agente usa: ele vê o título e o resumo de cada documento e lê o inteiro quando o assunto aparece. Por isso o resumo importa.
        </p>
        <div><RouterLink :to="`${info.base}/new`" class="btn btn-primary">{{ g.nova }} {{ info.one }}</RouterLink></div>
      </section>
    </template>
  </MasterDetail>

  <ConfirmDialog
    :open="removing"
    :title="`Apagar ${g.a} ${info.one}?`"
    :message="`${form.title} sai das próximas conversas.`"
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
