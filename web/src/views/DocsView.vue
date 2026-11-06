<script setup lang="ts">
import SaveFooter from '@/components/SaveFooter.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import ListFilter from '@/components/ListFilter.vue'
import TagChips from '@/components/TagChips.vue'
import TagsInput from '@/components/TagsInput.vue'
import { filterList, sameTags, tagNames } from '@/lib/listFilter'
import BuildTabs from '@/components/BuildTabs.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import HistoryPanel from '@/components/HistoryPanel.vue'
import AttachedDocs from '@/components/AttachedDocs.vue'
import DocStatusBadge from '@/components/DocStatusBadge.vue'
import SupersedesPicker from '@/components/SupersedesPicker.vue'
import HistoryTabs from '@/components/HistoryTabs.vue'
import ImportIssues from '@/components/ImportIssues.vue'
import ImportIssuesBadge from '@/components/ImportIssuesBadge.vue'
import ShareProjects from '@/components/ShareProjects.vue'
import SharedBadge from '@/components/SharedBadge.vue'
import { ApiError } from '@/lib/api'
import { DOC_STATUS_FILTER_LABEL, DOC_STATUS_FILTERS, DOC_STATUS_LABEL, DOC_STATUSES, docStatusOf, filterByStatus, isInactive, sameIds, statusCounts, type TDocStatusFilter } from '@/lib/docStatus'
import { sizeHint } from '@/lib/format'
import { pendingDraft } from '@/lib/builder'
import { attachableDocs, attachedRefs, attachmentsChanged, docSlug, GLOBAL_SCOPE, scopeLabel, scopeToProjectId, setAttachMode, sharedFromOf, withoutShared, type TAttachMode } from '@/lib/guidance'
import type { IRestoreResult } from '@/lib/catalogHistory'
import { renderMarkdown } from '@/lib/markdown'
import type { IProjectDoc, TDocKind, TDocStatus, TImportIssueMatch } from '@/lib/types'
import { useScopedDocs } from '@/composables/useCatalogLists'
import { useResource } from '@/composables/useResource'
import { useAuthStore } from '@/stores/auth'
import { useAgentsStore } from '@/stores/agents'
import { useDocsStore } from '@/stores/docs'
import { useProjectsStore } from '@/stores/projects'

/**
 * SPECS ou ADRs (só admin), uma página para cada (`kind`): documentos em markdown que os agentes consultam.
 * ⚖️ A conversa recebe só o índice (id, título, resumo) — os globais e os do projeto dela — e o agente lê o
 * documento inteiro com `read_doc` quando precisa. O status de uma ADR fica no próprio texto.
 * ⚖️ Relação com outro documento (spec que cita spec, ADR → spec) é ANEXO, feito aqui — não caminho citado no texto. O
 * anexado vai junto quando o documento é lido: inteiro ou por referência, como no anexo de skill.
 * As listas e o documento aberto moram na store: trocar de item ou de página não relê o que já veio.
 */
const props = defineProps<{ kind: TDocKind; id?: string }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const agents = useAgentsStore()
const docsStore = useDocsStore()

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
/** Lê quando a tela abre (só admin, com a lista de projetos). */
const ready = ref(false)
const listed = useResource(docsStore.lists, () => (ready.value ? docsStore.listKey(scope.value) : undefined))
// Num projeto, os globais vêm junto (a lista do servidor é só do escopo): os do projeto primeiro.
const globals = useResource(docsStore.lists, () => (ready.value && scope.value !== GLOBAL_SCOPE ? docsStore.listKey(GLOBAL_SCOPE) : undefined))
const list = computed(() => [...(listed.data.value ?? []), ...(scope.value !== GLOBAL_SCOPE ? (globals.data.value ?? []) : [])])
const loadError = computed(() => (listed.error.value === undefined ? undefined : describe(listed.error.value)))
const adding = computed(() => route.name === `${props.kind}-new`)
const info = computed(() => KIND[props.kind])
/** As palavras que concordam com o tipo: "Novo estudo", "Nova spec". */
const g = computed(() => (info.value.masc ? { nova: 'Novo', nenhuma: 'Nenhum', uma: 'um', a: 'o' } : { nova: 'Nova', nenhuma: 'Nenhuma', uma: 'uma', a: 'a' }))

const form = ref({ id: '', kind: 'spec' as TDocKind, title: '', summary: '', tags: [] as string[], body: '', global: true, project: '', docIds: [] as string[], docRefs: [] as string[], status: 'accepted' as TDocStatus, supersedes: [] as string[] })
/** A guia da edição: o formulário ou o histórico (`#historico` no endereço abre nele). */
type TDocTab = 'edit' | 'instructions' | 'attachments' | 'share' | 'issues' | 'history'
const HASH_TAB: Record<string, TDocTab> = { '#historico': 'history', '#instrucoes': 'instructions', '#anexos': 'attachments', '#compartilhar': 'share', '#problemas': 'issues' }
const tab = ref<TDocTab>(HASH_TAB[route.hash] ?? 'edit')
/** Muda depois de restaurar uma versão: relê o item. */
const reloadKey = ref(0)
const loaded = ref<IProjectDoc>()
/** Global: só o admin do gateway altera; quem administra o projeto lê. */
const globalLocked = computed(() => !auth.isAdmin && (adding.value ? form.value.global : !!loaded.value && !loaded.value.projectId))
/** Veio de outro projeto (compartilhado): o projeto de origem. Aqui é só leitura. */
const sharedFrom = computed(() => (adding.value || !loaded.value ? undefined : sharedFromOf(loaded.value, projects.current)))
const locked = computed(() => globalLocked.value || !!sharedFrom.value)
const preview = ref(false)
const issues = ref<Record<string, string[]>>({})
const error = ref<string>()
const note = ref<string>()
const busy = ref(false)
const removing = ref(false)

// O projeto escolhido no topo manda na lista: trocar lá troca aqui.
watch(
  () => projects.current,
  (id) => (scope.value = id ?? GLOBAL_SCOPE),
)
const ofKind = computed(() => list.value.filter((doc) => doc.kind === props.kind))
/** A busca e a tag do topo da lista. */
const query = ref('')
const tag = ref('')
/** O status do topo da lista (combina com a busca e a tag). */
const statusFilter = ref<TDocStatusFilter>('all')
const searched = computed(() => filterList(ofKind.value, { query: query.value, tag: tag.value }, (doc) => [doc.id, doc.title, doc.summary]))
/** Quantos há de cada status, já com a busca e a tag aplicadas. */
const statusTotals = computed(() => statusCounts(searched.value))
const shown = computed(() => filterByStatus(searched.value, statusFilter.value))
/** O filtro de status só aparece quando algum documento não é aceito (senão não há o que separar). */
const showStatusFilter = computed(() => ofKind.value.some((doc) => docStatusOf(doc) !== 'accepted') || statusFilter.value !== 'all')
/** As tags que a lista já usa (as sugestões do campo). */
const knownTags = computed(() => tagNames(ofKind.value))
const formScope = computed(() => (form.value.global ? GLOBAL_SCOPE : form.value.project))
/** Os documentos que este pode anexar: os globais e os do projeto do formulário (a lista não segue o filtro de escopo). */
const { list: docs } = useScopedDocs(() => (projects.manages ? scopeToProjectId(formScope.value) : undefined))
const attachable = computed(() => attachableDocs(docs.value, scopeToProjectId(formScope.value), form.value.id || undefined))
/** Os que este pode substituir: os de mesmo tipo, globais ou do projeto (o global só substitui global), nunca ele mesmo. */
const replaceable = computed(() => withoutShared(attachable.value).filter((doc) => doc.kind === form.value.kind))
/** Os documentos que o salvo diz que o substituem (o título vem da lista, quando está nela). */
const supersededBy = computed(() => (loaded.value?.supersededBy ?? []).map((id) => ({ id, title: docs.value.find((doc) => doc.id === id)?.title ?? id })))
/** O salvo está substituído ou arquivado: o aviso do topo do formulário. */
const savedStatus = computed(() => docStatusOf(loaded.value ?? {}))
const dirty = computed(() => {
  const doc = loaded.value
  if (!doc) return true
  return (
    form.value.title !== doc.title ||
    form.value.summary !== doc.summary ||
    !sameTags(form.value.tags, doc.tags) ||
    form.value.body !== (doc.body ?? '') ||
    formScope.value !== (doc.projectId ?? GLOBAL_SCOPE) ||
    form.value.status !== docStatusOf(doc) ||
    !sameIds(form.value.supersedes, doc.supersedes) ||
    attachmentsChanged(form.value, doc)
  )
})

onMounted(async () => {
  if (!projects.loaded) await projects.load().catch(() => undefined)
  if (!projects.manages) return
  // Os nomes dos agentes do selo "carregada em".
  if (!agents.loaded) void agents.load().catch(() => undefined)
  ready.value = true
})

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
        tags: [],
        body: TEMPLATE[kind],
        global: scope.value === GLOBAL_SCOPE && auth.isAdmin,
        project: scope.value === GLOBAL_SCOPE ? (projects.current ?? '') : scope.value,
        docIds: [],
        docRefs: [],
        status: 'accepted',
        supersedes: [],
      }
      applyDraft(kind)
      return
    }
    if (!id) return
    try {
      const doc = await docsStore.details.ensure(id)
      // Outro item aberto enquanto este vinha: o mais novo manda.
      if (props.id !== id) return
      // O endereço é da outra página (uma ADR aberta em /specs): vai para a certa.
      if (doc.kind !== kind) return void router.replace(`${KIND[doc.kind].base}/${doc.id}`)
      loaded.value = doc
      form.value = {
        id: doc.id,
        kind: doc.kind,
        title: doc.title,
        summary: doc.summary,
        tags: [...(doc.tags ?? [])],
        body: doc.body ?? '',
        global: !doc.projectId,
        project: doc.projectId ?? projects.current ?? '',
        docIds: [...(doc.docIds ?? [])],
        docRefs: [...(doc.docRefs ?? [])],
        status: docStatusOf(doc),
        supersedes: [...(doc.supersedes ?? [])],
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
    // O rascunho do construtor não traz tags: ficam as do formulário.
    tags: form.value.tags,
    body: draft.body,
    global: !draft.projectId,
    project: draft.projectId ?? projects.current ?? '',
    docIds: [...draft.docIds],
    docRefs: [...draft.docRefs],
    // O rascunho do construtor não traz status nem substituição: ficam os do formulário.
    status: form.value.status,
    supersedes: form.value.supersedes,
  }
  note.value = 'Rascunho do construtor aplicado: revise e salve.'
}

function toggleDoc(id: string) {
  form.value.docIds = form.value.docIds.includes(id) ? form.value.docIds.filter((item) => item !== id) : [...form.value.docIds, id]
}

function toggleSuperseded(id: string) {
  form.value.supersedes = form.value.supersedes.includes(id) ? form.value.supersedes.filter((item) => item !== id) : [...form.value.supersedes, id]
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
  // Um doc de outro escopo não vai junto como substituído quando o escopo muda.
  const supersedes = form.value.supersedes.filter((id) => replaceable.value.some((doc) => doc.id === id))
  const body = {
    kind: form.value.kind,
    title: form.value.title,
    summary: form.value.summary,
    tags: form.value.tags,
    body: form.value.body,
    projectId: scopeToProjectId(formScope.value),
    docIds,
    docRefs: attachedRefs(docIds, form.value.docRefs),
    status: form.value.status,
    supersedes,
  }
  try {
    if (adding.value) {
      const created = await docsStore.create({ id: form.value.id, ...body })
      scope.value = created.projectId ?? GLOBAL_SCOPE
      await router.push(`${info.value.base}/${created.id}`)
    } else {
      loaded.value = await docsStore.update(form.value.id, body)
      form.value.tags = [...(loaded.value.tags ?? [])]
      form.value.docIds = [...(loaded.value.docIds ?? [])]
      form.value.docRefs = [...(loaded.value.docRefs ?? [])]
      form.value.status = docStatusOf(loaded.value)
      form.value.supersedes = [...(loaded.value.supersedes ?? [])]
      note.value = 'Salvo. Vale para as próximas conversas.'
    }
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) issues.value = failure.fieldIssues
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

/** "Resolvido" (ou "Descartar", um ou todos os pendentes): a store grava e devolve o documento (o formulário fica como está). */
async function resolveIssue(issue: TImportIssueMatch) {
  if (loaded.value) loaded.value = await docsStore.resolveIssue(loaded.value.id, issue)
}

/** Restaurou uma versão: a store relê o item e as listas; se a versão era a de antes de existir, o item sumiu. */
async function restored(result: IRestoreResult) {
  const id = loaded.value?.id ?? props.id
  if (id) await docsStore.restored(id, result.exists)
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
    await docsStore.remove(form.value.id)
    removing.value = false
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

/** Compartilha spec e conhecimento (ADR não): o aberto é de um projeto, não veio de outro e a pessoa administra o projeto atual. */
const canShare = computed(() => !adding.value && loaded.value?.kind !== 'adr' && !!loaded.value?.projectId && !sharedFrom.value && projects.manages)
async function saveShares(list: string[]) {
  if (loaded.value) loaded.value = await docsStore.share(loaded.value.id, list)
}

/** Os problemas da importação do item aberto (a guia só existe com algum). */
const importIssues = computed(() => (adding.value ? [] : (loaded.value?.importIssues ?? [])))
/** As guias além da principal (título, resumo, escopo, anexos): as instruções (o texto e a prévia) e os problemas. */
const extraTabs = computed(() =>
  [
    { id: 'instructions' as const, label: 'Instruções' },
    { id: 'attachments' as const, label: `Anexos${form.value.docIds.length ? ` (${form.value.docIds.length})` : ''}` },
    ...(canShare.value ? [{ id: 'share' as const, label: `Compartilhar${loaded.value?.sharedWith?.length ? ` (${loaded.value.sharedWith.length})` : ''}` }] : []),
    ...(importIssues.value.length ? [{ id: 'issues' as const, label: `Problemas da importação (${importIssues.value.length})` }] : []),
  ].filter((item) => !adding.value || item.id === 'instructions' || item.id === 'attachments'),
)
// A guia de problemas some quando o último é resolvido: volta à principal.
watch(importIssues, (list) => {
  if (tab.value === 'issues' && !list.length) tab.value = 'edit'
})
/** O campo obrigatório vazio está noutra guia: abre a dele (senão o navegador não consegue apontar para ele). */
function onInvalid(event: Event) {
  const target = (event.target as HTMLElement).dataset.tab
  tab.value = target === 'instructions' || target === 'attachments' ? target : 'edit'
}
</script>

<template>
  <div v-if="!projects.manages" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra este projeto pode gerenciar {{ info.title }}.</p>
  </div>

  <MasterDetail v-else :open="!!id || adding" :back-to="info.base" :back-label="info.title" :title="adding ? `${g.nova} ${info.one}` : loaded?.title">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-3">
        <h1 class="text-xl font-semibold">{{ info.title }}</h1>
        <RouterLink :to="`${info.base}/new`" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" :title="`${g.nova} ${info.one}`"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <BuildTabs :kind="kind" active="list" class="px-3 pb-2" />
      <!-- ⚖️ Sem seletor de projeto aqui: a lista segue o projeto escolhido no topo (e traz os globais junto). -->
      <p class="px-4 pb-2 text-xs text-zinc-500" data-test="scope-caption">
        {{ scope === GLOBAL_SCOPE ? 'Mostrando os globais (nenhum projeto escolhido no topo).' : `Mostrando ${scopeLabel(scope, projects.list)} e os globais.` }}
      </p>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <ListFilter v-if="ofKind.length" v-model:query="query" v-model:tag="tag" :placeholder="`Buscar ${info.one}…`" :items="ofKind" />
      <div v-if="showStatusFilter" class="flex gap-1.5 overflow-x-auto px-3 pb-2" role="group" aria-label="Status" data-test="status-filter">
        <button v-for="item in DOC_STATUS_FILTERS" :key="item" type="button" class="chip shrink-0" :class="{ on: statusFilter === item }" @click="statusFilter = item">
          {{ DOC_STATUS_FILTER_LABEL[item] }} <span class="text-zinc-500">{{ statusTotals[item] }}</span>
        </button>
      </div>
      <p v-if="!loadError && ofKind.length && !shown.length" class="px-4 py-2 text-sm text-zinc-500">{{ g.nenhuma }} {{ info.one }} com essa busca.</p>
      <p v-else-if="!loadError && !ofKind.length" class="px-4 py-2 text-sm text-zinc-500">{{ g.nenhuma }} {{ info.one }} em {{ scopeLabel(scope, projects.list) }}.</p>
      <RouterLink v-for="doc in shown" :key="doc.id" :to="`${info.base}/${doc.id}`" class="mx-2 block rounded-xl px-3 py-2" :class="[doc.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60', { 'opacity-60': isInactive(docStatusOf(doc)) }]">
        <span class="flex items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ doc.title }}</span>
          <span v-if="scope !== GLOBAL_SCOPE && !doc.projectId" class="shrink-0 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">global</span>
          <SharedBadge :from="doc.sharedFrom" />
          <DocStatusBadge :status="doc.status" />
        </span>
        <span class="block truncate text-xs text-zinc-500">{{ doc.id }}<template v-if="doc.summary"> · {{ doc.summary }}</template></span>
        <span v-if="loadedLabel(doc)" class="mt-1 inline-block max-w-full truncate rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">usada em {{ loadedLabel(doc) }}</span>
        <TagChips :tags="doc.tags" />
        <ImportIssuesBadge :count="doc.importIssues?.length" class="mt-1" />
      </RouterLink>
    </template>

    <template #detail>
      <div v-if="adding || loaded" class="mx-auto mb-4 max-w-3xl"><HistoryTabs v-model="tab" edit-label="Documento" :extra="extraTabs" :history="!adding" /></div>
      <form v-if="adding || (loaded && (tab === 'edit' || tab === 'instructions' || tab === 'attachments'))" class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="save" @invalid.capture="onInvalid">
        <h2 class="text-lg font-semibold">{{ adding ? `${g.nova} ${info.one}` : loaded?.title }}</h2>
        <p v-if="sharedFrom" class="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-200" data-test="shared-readonly">Compartilhado por {{ scopeLabel(sharedFrom, projects.list) }}: só leitura aqui; a manutenção é lá.</p>
        <p v-else-if="locked" class="text-xs text-amber-300" data-test="global-readonly">Global: só o administrador do gateway altera.</p>
        <fieldset :disabled="locked" class="contents">
        <!-- O aviso de quem lê: o salvo está fora do índice da conversa (vale em todas as guias, inclusive a prévia). -->
        <p v-if="!adding && isInactive(savedStatus)" class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200" data-test="inactive-banner">
          <template v-if="savedStatus === 'superseded' && supersededBy.length">
            Substituída por
            <template v-for="(item, index) in supersededBy" :key="item.id"><template v-if="index">, </template><RouterLink :to="`${info.base}/${item.id}`" class="font-medium underline">{{ item.title }}</RouterLink></template>
            — siga {{ supersededBy.length > 1 ? 'esses' : 'esse' }}.
          </template>
          <template v-else>{{ savedStatus === 'superseded' ? 'Substituída' : 'Arquivada' }}: fora do que a conversa vê.</template>
        </p>
        <div v-show="tab === 'edit'" class="flex flex-col gap-3">
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
        <TagsInput v-model="form.tags" label="Tags" :suggestions="knownTags" :issues="issues.tags" />
        <label class="field">
          Status
          <select v-model="form.status" class="input w-auto py-1.5 text-sm">
            <option v-for="item in DOC_STATUSES" :key="item" :value="item">{{ DOC_STATUS_LABEL[item] }}</option>
          </select>
          <small class="hint">Substituída e arquivada saem do que a conversa vê; continuam na lista.</small>
          <small v-for="m in issues.status" :key="m" class="error">{{ m }}</small>
        </label>
        <div class="field" role="group" aria-label="Substitui">
          Substitui
          <SupersedesPicker :options="replaceable" :selected="form.supersedes" :empty-text="form.global ? 'Nenhum outro documento global.' : 'Nenhum outro documento global ou deste projeto.'" @toggle="toggleSuperseded" />
          <small v-if="form.supersedes.length" class="hint">Ao salvar, as substituídas ficam com status substituída.</small>
          <small v-for="m in issues.supersedes" :key="m" class="error">{{ m }}</small>
        </div>
        <p v-if="supersededBy.length" class="text-sm text-zinc-400" data-test="superseded-by">
          Substituída por:
          <template v-for="(item, index) in supersededBy" :key="item.id"><template v-if="index">, </template><RouterLink :to="`${info.base}/${item.id}`" class="text-emerald-300 hover:underline">{{ item.title }}</RouterLink></template>
        </p>
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <label class="flex items-center gap-2"><input v-model="form.global" type="checkbox" :disabled="!auth.isAdmin" class="accent-emerald-500" /> Global (todos os projetos)</label>
          <select v-if="!form.global" v-model="form.project" required class="input w-auto py-1.5 text-sm" aria-label="Projeto">
            <option v-for="project in projects.list.filter((item) => item.id === projects.current || item.id === form.project)" :key="project.id" :value="project.id">{{ project.name }}</option>
          </select>
          <small v-for="m in issues.projectId" :key="m" class="error">{{ m }}</small>
        </div>
        <small v-if="issues.body?.length" class="error">O conteúdo tem problema: veja a guia Instruções.</small>

        <small v-if="issues.docIds?.length || issues.docRefs?.length" class="error">Os anexos têm problema: veja a guia Anexos.</small>
        </div>

        <!-- As instruções: o texto e a prévia, numa guia só deles (o principal fica com título, resumo e anexos). -->
        <div v-show="tab === 'instructions'" class="flex flex-col gap-1">
          <div class="flex gap-1 text-xs">
            <button type="button" class="btn btn-sm" :class="!preview ? 'btn-secondary' : 'btn-ghost'" @click="preview = false">Markdown</button>
            <button type="button" class="btn btn-sm" :class="preview ? 'btn-secondary' : 'btn-ghost'" @click="preview = true">Prévia</button>
          </div>
          <textarea v-if="!preview" v-model="form.body" required rows="22" data-tab="instructions" class="input font-mono text-[13px] leading-relaxed" aria-label="Conteúdo em markdown" />
          <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
          <div v-else class="prose-agent min-h-[18rem] rounded-xl border border-zinc-800 p-4 text-sm break-words" v-html="renderMarkdown(form.body)" />
          <small v-if="form.body" class="hint">{{ sizeHint(form.body, 'quando lido') }}</small>
          <small v-for="m in issues.body" :key="m" class="error">{{ m }}</small>
        </div>

        <!-- Os anexos: os escolhidos em cima, todos os que dá para anexar embaixo. -->
        <div v-show="tab === 'attachments'" class="flex flex-col gap-2">
          <AttachedDocs :attachable="attachable" :selected="form.docIds" :mode-of="attachMode" :empty-text="form.global ? 'Nenhum documento global.' : 'Nenhum documento global ou deste projeto.'" @toggle="toggleDoc" @mode="setMode" />
          <small class="hint">A relação com outro documento (spec que cita spec, ADR que aponta a spec) é anexo aqui, não caminho no texto. Inteiro: o texto vai junto. Por referência: vão só id, título e
            tamanho, e o agente lê com read_doc se precisar. O anexo de um anexo vai sempre por referência.</small>
          <small v-for="m in issues.docIds" :key="m" class="error">{{ m }}</small>
          <small v-for="m in issues.docRefs" :key="m" class="error">{{ m }}</small>
        </div>

        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
        <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
        </fieldset>
        <SaveFooter v-if="!locked" submit :label="`${adding ? 'Criar' : 'Salvar'} ${info.one}`" :busy="busy" :disabled="!(dirty)" :pending="!adding && (dirty)">
          <RouterLink v-if="adding" :to="info.base" class="btn btn-ghost">Cancelar</RouterLink>
          <template v-if="!adding" #end>
            <button type="button" class="btn btn-danger" @click="removing = true">Apagar {{ info.one }}</button>
          </template>
        </SaveFooter>
      </form>
      <section v-else-if="loaded && tab === 'share' && canShare" class="mx-auto flex max-w-3xl flex-col gap-3">
        <h2 class="text-lg font-semibold">{{ loaded.title }}</h2>
        <ShareProjects :owner="loaded.projectId ?? ''" :shared="loaded.sharedWith ?? []" :save="saveShares" />
      </section>
      <section v-else-if="loaded && tab === 'issues'" class="mx-auto flex max-w-3xl flex-col gap-3">
        <h2 class="text-lg font-semibold">{{ loaded.title }}</h2>
        <ImportIssues :issues="importIssues" :resolve="resolveIssue" />
      </section>
      <section v-else-if="loaded && tab === 'history'" class="mx-auto flex max-w-3xl flex-col gap-3">
        <h2 class="text-lg font-semibold">{{ loaded.title }}</h2>
        <HistoryPanel :kind="kind" :id="loaded.id" :readonly="locked" @restored="restored" />
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
