<script setup lang="ts">
import SaveFooter from '@/components/SaveFooter.vue'
import ConnectedReadOnly from '@/components/ConnectedReadOnly.vue'
import { useConnectionsStore } from '@/stores/connections'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import ListFilter from '@/components/ListFilter.vue'
import TagChips from '@/components/TagChips.vue'
import TagsInput from '@/components/TagsInput.vue'
import { countLabel, filterList, sameTags, sortByName, tagNames } from '@/lib/listFilter'
import MasterDetail from '@/components/MasterDetail.vue'
import HistoryPanel from '@/components/HistoryPanel.vue'
import AttachedDocs from '@/components/AttachedDocs.vue'
import HistoryTabs from '@/components/HistoryTabs.vue'
import ImportIssues from '@/components/ImportIssues.vue'
import ImportIssuesBadge from '@/components/ImportIssuesBadge.vue'
import ResourceFiles from '@/components/ResourceFiles.vue'
import ShareProjects from '@/components/ShareProjects.vue'
import SharedBadge from '@/components/SharedBadge.vue'
import SecretVariables from '@/components/SecretVariables.vue'
import TriggersEditor from '@/components/TriggersEditor.vue'
import BuildTabs from '@/components/BuildTabs.vue'
import { pendingDraft } from '@/lib/builder'
import { ApiError } from '@/lib/api'
import { sizeHint } from '@/lib/format'
import { attachableDocs, attachedRefs, docSlug, GLOBAL_SCOPE, scopeLabel, scopeToProjectId, setAttachMode, sharedFromOf, type TAttachMode } from '@/lib/guidance'
import type { IRestoreResult } from '@/lib/catalogHistory'
import { renderMarkdown } from '@/lib/markdown'
import type { IAgentTrigger, IResource, TImportIssueMatch, TResourceKind } from '@/lib/types'
import { envDuplicates, envRecord, envRows, type IEnvRow } from '@/lib/agentForm'
import { useScopedDocs } from '@/composables/useCatalogLists'
import { useResource } from '@/composables/useResource'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useResourcesStore } from '@/stores/resources'

/**
 * SKILLS ou COMMANDS (só admin), uma página para cada (`kind`). ⚖️ O agente só usa o que a guia Recursos dele libera.
 * A skill entra no índice do prompt (nome e descrição) e o agente a carrega com `use_resource`; o command a pessoa dispara
 * com `/nome argumentos`, e o gateway troca pelo texto dele. Os dois levam as specs e ADRs anexadas — cada uma inteira
 * ou por referência (id, título e tamanho; o agente a lê com `read_doc` se precisar), à escolha de quem cadastra.
 * As listas e o recurso aberto moram na store: a gravação põe a resposta nela, sem reler.
 */
const props = defineProps<{ kind: TResourceKind; id?: string }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const connections = useConnectionsStore()
const resources = useResourcesStore()

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
/** Lê quando a tela abre (só admin, com a lista de projetos). */
const ready = ref(false)
const listed = useResource(resources.lists, () => (ready.value ? resources.listKey(scope.value, props.kind) : undefined))
// Num projeto, os globais vêm junto (a lista do servidor é só do escopo); a ordem é a do nome.
const globals = useResource(resources.lists, () => (ready.value && scope.value !== GLOBAL_SCOPE ? resources.listKey(GLOBAL_SCOPE, props.kind) : undefined))
const all = computed(() => [...(listed.data.value ?? []), ...(scope.value !== GLOBAL_SCOPE ? (globals.data.value ?? []) : [])])
/** A busca e a tag do topo da lista. */
const query = ref('')
const tag = ref('')
const list = computed(() =>
  sortByName(
    filterList(all.value, { query: query.value, tag: tag.value }, (resource) => [resource.id, resource.description]),
    (resource) => resource.id,
  ),
)
/** As tags que a lista já usa (as sugestões do campo). */
const knownTags = computed(() => tagNames(all.value))
const loadError = computed(() => (listed.error.value === undefined ? undefined : describe(listed.error.value)))
const adding = computed(() => route.name === `${props.kind}-new`)
const info = computed(() => KIND[props.kind])
/** As palavras que concordam com o tipo: "Novo estudo", "Nova spec". */
const g = computed(() => (info.value.masc ? { nova: 'Novo', nenhuma: 'Nenhum', uma: 'um', a: 'o' } : { nova: 'Nova', nenhuma: 'Nenhuma', uma: 'uma', a: 'a' }))

const form = ref({ id: '', description: '', tags: [] as string[], body: '', global: true, project: '', docIds: [] as string[], docRefs: [] as string[], triggers: [] as IAgentTrigger[], env: [] as IEnvRow[] })
const envRepeated = computed(() => envDuplicates(form.value.env))
/** A guia da edição: o formulário ou o histórico (`#historico` no endereço abre nele). */
type TResourceTab = 'edit' | 'instructions' | 'triggers' | 'attachments' | 'files' | 'variables' | 'share' | 'issues' | 'history'
const HASH_TAB: Record<string, TResourceTab> = {
  '#historico': 'history',
  '#instrucoes': 'instructions',
  '#triggers': 'triggers',
  '#anexos': 'attachments',
  '#arquivos': 'files',
  '#variaveis': 'variables',
  '#compartilhar': 'share',
  '#problemas': 'issues',
}
const tab = ref<TResourceTab>(HASH_TAB[route.hash] ?? 'edit')
/** Muda depois de restaurar uma versão: relê o item. */
const reloadKey = ref(0)
const loaded = ref<IResource>()
/** Global: só o admin do gateway altera; quem administra o projeto lê. */
const globalLocked = computed(() => !auth.isAdmin && (adding.value ? form.value.global : !!loaded.value && !loaded.value.projectId))
/** Veio de outro projeto (compartilhado): o projeto de origem. Aqui é só leitura. */
const sharedFrom = computed(() => (adding.value || !loaded.value ? undefined : sharedFromOf(loaded.value, projects.current)))
/** 🔌 Do projeto conectado: só leitura (o catálogo vem da origem). */
const connectedOrigin = computed(() => connections.originOf(adding.value ? projects.current : loaded.value?.projectId))
const locked = computed(() => globalLocked.value || !!sharedFrom.value || !!connectedOrigin.value)
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
const formScope = computed(() => (form.value.global ? GLOBAL_SCOPE : form.value.project))
const { list: docs } = useScopedDocs(() => (projects.manages ? scopeToProjectId(formScope.value) : undefined))
/** Os documentos que podem ir anexados: os globais e, num recurso de projeto, os do projeto e os compartilhados com ele. */
const attachable = computed(() => attachableDocs(docs.value, scopeToProjectId(formScope.value)))
const dirty = computed(() => {
  const resource = loaded.value
  if (!resource) return true
  return (
    form.value.description !== resource.description ||
    !sameTags(form.value.tags, resource.tags) ||
    form.value.body !== resource.body ||
    formScope.value !== (resource.projectId ?? GLOBAL_SCOPE) ||
    form.value.docIds.join() !== resource.docIds.join() ||
    attachedRefs(form.value.docIds, form.value.docRefs).join() !== attachedRefs(resource.docIds, resource.docRefs ?? []).join() ||
    JSON.stringify(form.value.triggers) !== JSON.stringify(resource.triggers ?? []) ||
    JSON.stringify(envRecord(form.value.env) ?? {}) !== JSON.stringify(resource.env ?? {})
  )
})

onMounted(async () => {
  if (!projects.loaded) await projects.load().catch(() => undefined)
  if (!projects.manages) return
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
        description: '',
        tags: [],
        body: KIND[kind].template,
        global: scope.value === GLOBAL_SCOPE && auth.isAdmin,
        project: scope.value === GLOBAL_SCOPE ? (projects.current ?? '') : scope.value,
        docIds: [],
        docRefs: [],
        triggers: [],
        env: [],
      }
      applyDraft(kind)
      return
    }
    if (!id) return
    try {
      const resource = await resources.details.ensure(id)
      // Outro item aberto enquanto este vinha: o mais novo manda.
      if (props.id !== id) return
      if (resource.kind !== kind) return void router.replace(`${KIND[resource.kind].base}/${resource.id}`)
      loaded.value = resource
      form.value = {
        id: resource.id,
        description: resource.description,
        tags: [...(resource.tags ?? [])],
        body: resource.body,
        global: !resource.projectId,
        project: resource.projectId ?? projects.current ?? '',
        docIds: [...resource.docIds],
        docRefs: [...(resource.docRefs ?? [])],
        triggers: copyTriggers(resource.triggers),
        env: envRows(resource.env),
      }
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
    // O rascunho não traz tags: ficam as do formulário.
    tags: form.value.tags,
    body: draft.body,
    global: !draft.projectId,
    project: draft.projectId ?? projects.current ?? '',
    docIds: [...draft.docIds],
    docRefs: [...draft.docRefs],
    // O rascunho não traz triggers nem variáveis: ficam os do recurso aberto.
    triggers: form.value.triggers,
    env: form.value.env,
  }
  note.value = 'Rascunho do construtor aplicado: revise e salve.'
}

/** Cópia para o formulário (editar não mexe no recurso carregado, que é a base do "mudou?"). */
function copyTriggers(triggers: IResource['triggers']): IAgentTrigger[] {
  return (triggers ?? []).map((trigger) => ({ ...trigger }))
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
  if (!form.value.id && form.value.description) form.value.id = docSlug(form.value.description).split('-').slice(0, 4).join('-')
}

/** A guia Arquivos: grava só a lista (o resto da skill fica). */
/** A guia Arquivos, montada dentro do formulário: o Salvar grava o rascunho dela (`commit`). */
const filesPart = ref<{ dirty: boolean; commit: () => Promise<void> }>()

async function saveFiles(files: IResource['files']) {
  if (!loaded.value) return
  loaded.value = await resources.saveFiles(loaded.value.id, files)
}

/** "Resolvido" (ou "Descartar", um ou todos os pendentes): a store grava e devolve o recurso (o formulário fica como está). */
async function resolveIssue(issue: TImportIssueMatch) {
  if (loaded.value) loaded.value = await resources.resolveIssue(loaded.value.id, issue)
}

async function save() {
  issues.value = {}
  error.value = undefined
  note.value = undefined
  busy.value = true
  // Um doc de outro projeto não vai junto quando o escopo muda.
  const docIds = form.value.docIds.filter((id) => attachable.value.some((doc) => doc.id === id))
  const body = {
    description: form.value.description,
    tags: form.value.tags,
    body: form.value.body,
    projectId: scopeToProjectId(formScope.value),
    docIds,
    docRefs: attachedRefs(docIds, form.value.docRefs),
    triggers: form.value.triggers,
    env: envRecord(form.value.env) ?? {},
  }
  try {
    if (adding.value) {
      const created = await resources.create({ id: form.value.id, kind: props.kind, ...body })
      scope.value = created.projectId ?? GLOBAL_SCOPE
      await router.push(`${info.value.base}/${created.id}`)
    } else {
      if (dirty.value) {
        loaded.value = await resources.update(form.value.id, body)
        form.value.tags = [...(loaded.value.tags ?? [])]
        form.value.docIds = [...loaded.value.docIds]
        form.value.docRefs = [...(loaded.value.docRefs ?? [])]
        form.value.triggers = copyTriggers(loaded.value.triggers)
        form.value.env = envRows(loaded.value.env)
      }
      // Os arquivos vão no mesmo Salvar.
      await filesPart.value?.commit()
      note.value = 'Salvo. Vale para as próximas conversas.'
    }
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) issues.value = failure.fieldIssues
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

/** Restaurou uma versão: a store relê o item e o põe nas listas; se a versão era a de antes de existir, o item sumiu. */
async function restored(result: IRestoreResult) {
  const id = loaded.value?.id ?? props.id
  if (id) await resources.restored(id, result.exists).catch(() => undefined)
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
    await resources.remove(form.value.id)
    removing.value = false
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

/** Compartilha: o item aberto é de um projeto (não global), não veio de outro e a pessoa administra o projeto atual. */
const canShare = computed(() => !adding.value && !!loaded.value?.projectId && !sharedFrom.value && projects.manages)
async function saveShares(list: string[]) {
  if (loaded.value) loaded.value = await resources.share(loaded.value.id, list)
}
/** Os valores das variáveis são de um projeto: o dono do item, ou o projeto atual quando o item é compartilhado (global: sem). */
const secretsProject = computed(() => sharedFrom.value ? projects.current : loaded.value?.projectId)

/** Os problemas da importação do item aberto (a guia só existe com algum). */
const importIssues = computed(() => (adding.value ? [] : (loaded.value?.importIssues ?? [])))
/** As guias além da principal (título, resumo, escopo, anexos): as instruções (o texto e a prévia), os arquivos e os problemas. */
const extraTabs = computed(() =>
  [
    { id: 'instructions' as const, label: 'Instruções' },
    { id: 'triggers' as const, label: `Triggers${form.value.triggers.length ? ` (${form.value.triggers.length})` : ''}` },
    { id: 'attachments' as const, label: `Anexos${form.value.docIds.length ? ` (${form.value.docIds.length})` : ''}` },
  { id: 'files' as const, label: `Arquivos${loaded.value?.files?.length ? ` (${loaded.value.files.length})` : ''}` },
    // As variáveis: as fixas (com o Salvar) e as secretas (só admin; o valor entra e nunca volta).
    // O item compartilhado também tem a guia: as fixas são da origem (só leitura); os valores secretos, DESTE projeto.
    ...(projects.manages && !globalLocked.value ? [{ id: 'variables' as const, label: `Variáveis${form.value.env.length ? ` (${form.value.env.length})` : ''}` }] : []),
    // Compartilhar: só o item de um projeto, e do projeto dono (quem recebe não repassa).
    ...(canShare.value ? [{ id: 'share' as const, label: `Compartilhar${loaded.value?.sharedWith?.length ? ` (${loaded.value.sharedWith.length})` : ''}` }] : []),
    ...(importIssues.value.length ? [{ id: 'issues' as const, label: `Problemas da importação (${importIssues.value.length})` }] : []),
  ].filter((item) => !adding.value || item.id === 'instructions' || item.id === 'triggers' || item.id === 'attachments'),
)
// A guia de problemas some quando o último é resolvido: volta à principal.
watch(importIssues, (list) => {
  if (tab.value === 'issues' && !list.length) tab.value = 'edit'
})
/** O campo obrigatório vazio está noutra guia: abre a dele (senão o navegador não consegue apontar para ele). */
function onInvalid(event: Event) {
  const target = (event.target as HTMLElement).dataset.tab
  tab.value = target === 'instructions' || target === 'triggers' || target === 'attachments' ? target : 'edit'
}
</script>

<template>
  <div v-if="!projects.manages" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra este projeto pode gerenciar {{ info.title }}.</p>
  </div>

  <MasterDetail v-else :open="!!id || adding" :back-to="info.base" :back-label="info.title" :title="adding ? `${g.nova} ${info.one}` : loaded?.id">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-3">
        <h1 class="text-xl font-semibold">{{ info.title }}</h1>
        <span class="text-sm text-zinc-500" data-test="list-count">{{ countLabel(list.length, all.length) }}</span>
        <RouterLink v-if="!connections.originOf(projects.current)" :to="`${info.base}/new`" class="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" :title="`${g.nova} ${info.one}`"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <BuildTabs :kind="kind" active="list" class="px-3 pb-2" />
      <!-- ⚖️ Sem seletor de projeto aqui: a lista segue o projeto escolhido no topo (e traz os globais junto). -->
      <p class="px-4 pb-2 text-xs text-zinc-500" data-test="scope-caption">
        {{ scope === GLOBAL_SCOPE ? 'Mostrando os globais (nenhum projeto escolhido no topo).' : `Mostrando ${scopeLabel(scope, projects.list)} e os globais.` }}
      </p>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <ListFilter v-if="all.length" v-model:query="query" v-model:tag="tag" :placeholder="`Buscar ${info.one}…`" :items="all" />
      <p v-if="!loadError && all.length && !list.length" class="px-4 py-2 text-sm text-zinc-500">{{ g.nenhuma }} {{ info.one }} com essa busca.</p>
      <p v-else-if="!loadError && !all.length" class="px-4 py-2 text-sm text-zinc-500">{{ g.nenhuma }} {{ info.one }} em {{ scopeLabel(scope, projects.list) }}.</p>
      <RouterLink v-for="resource in list" :key="resource.id" :to="`${info.base}/${resource.id}`" class="mx-2 block rounded-xl px-3 py-2" :class="resource.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'">
        <span class="flex items-center gap-2">
          <span class="truncate font-mono text-sm">{{ kind === 'command' ? '/' : '' }}{{ resource.id }}</span>
          <span v-if="scope !== GLOBAL_SCOPE && !resource.projectId" class="shrink-0 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">global</span>
          <SharedBadge :from="resource.sharedFrom" />
        </span>
        <span class="block truncate text-xs text-zinc-500">{{ resource.description }}<template v-if="resource.docIds.length"> · {{ resource.docIds.length }} doc(s)</template></span>
        <TagChips :tags="resource.tags" />
        <ImportIssuesBadge :count="resource.importIssues?.length" class="mt-1" />
      </RouterLink>
    </template>

    <template #detail>
      <div v-if="adding || loaded" class="mx-auto mb-4 max-w-3xl"><HistoryTabs v-model="tab" :edit-label="info.one.charAt(0).toUpperCase() + info.one.slice(1)" :extra="extraTabs" :history="!adding" /></div>
      <form v-if="adding || (loaded && (tab === 'edit' || tab === 'instructions' || tab === 'triggers' || tab === 'attachments' || tab === 'files' || tab === 'variables'))" class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="save" @invalid.capture="onInvalid">
        <h2 class="font-mono text-lg font-semibold">{{ adding ? `${g.nova} ${info.one}` : `${kind === 'command' ? '/' : ''}${loaded?.id}` }}</h2>
        <ConnectedReadOnly v-if="connectedOrigin" :origin="connectedOrigin" />
        <p v-else-if="sharedFrom" class="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-200" data-test="shared-readonly">Compartilhado por {{ scopeLabel(sharedFrom, projects.list) }}: só leitura aqui; a manutenção é lá.</p>
        <p v-else-if="locked" class="text-xs text-amber-300" data-test="global-readonly">Global: só o administrador do gateway altera.</p>
        <fieldset :disabled="locked" class="contents">
        <div v-show="tab === 'edit'" class="flex flex-col gap-3">
        <label class="field">
          Descrição
          <input v-model="form.description" required maxlength="300" class="input" :placeholder="kind === 'command' ? 'Resume um arquivo em 3 linhas' : 'Montar tabelas em markdown'" @blur="slug" />
          <small class="hint">Uma linha: diz quando usar.</small>
          <small v-for="m in issues.description" :key="m" class="error">{{ m }}</small>
        </label>
        <TagsInput v-model="form.tags" label="Tags" :suggestions="knownTags" :issues="issues.tags" />
        <label class="field">
          Identificador
          <input v-model="form.id" :disabled="!adding" required pattern="[a-z0-9][a-z0-9-]{1,47}" class="input font-mono disabled:opacity-60" :placeholder="kind === 'command' ? 'resumir' : 'tabela-markdown'" />
          <small class="hint">{{ kind === 'command' ? 'É o /nome que a pessoa digita.' : 'Identifica a skill.' }} Não muda depois.</small>
          <small v-for="m in issues.id" :key="m" class="error">{{ m }}</small>
        </label>
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <label class="flex items-center gap-2"><input v-model="form.global" type="checkbox" :disabled="!auth.isAdmin" class="accent-emerald-500" /> Global (todos os projetos)</label>
          <select v-if="!form.global" v-model="form.project" required class="input w-auto py-1.5 text-sm" aria-label="Projeto">
            <!-- Só o projeto escolhido no topo (ou o do item, se for outro): sem lista de projetos aqui. -->
            <option v-for="project in projects.list.filter((item) => item.id === projects.current || item.id === form.project)" :key="project.id" :value="project.id">{{ project.name }}</option>
          </select>
          <small v-for="m in issues.projectId" :key="m" class="error">{{ m }}</small>
        </div>
        <small v-if="issues.body?.length" class="error">O conteúdo tem problema: veja a guia Instruções.</small>

        <small v-if="issues.docIds?.length || issues.docRefs?.length" class="error">Os anexos têm problema: veja a guia Anexos.</small>
        </div>

        <!-- As instruções: o texto e a prévia, numa guia só deles (o principal fica com descrição, escopo e anexos). -->
        <div v-show="tab === 'instructions'" class="flex flex-col gap-1">
          <div class="flex gap-1 text-xs">
            <button type="button" class="btn btn-sm" :class="!preview ? 'btn-secondary' : 'btn-ghost'" @click="preview = false">{{ kind === 'command' ? 'Texto' : 'Markdown' }}</button>
            <button type="button" class="btn btn-sm" :class="preview ? 'btn-secondary' : 'btn-ghost'" @click="preview = true">Prévia</button>
          </div>
          <textarea v-if="!preview" v-model="form.body" required rows="22" data-tab="instructions" class="input font-mono text-[13px] leading-relaxed" :aria-label="info.bodyHint" />
          <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
          <div v-else class="prose-agent min-h-[14rem] rounded-xl border border-zinc-800 p-4 text-sm break-words" v-html="renderMarkdown(form.body)" />
          <small class="hint">{{ info.bodyHint }}</small>
          <small v-if="form.body" class="hint">{{ sizeHint(form.body, kind === 'command' ? 'quando usado' : 'quando carregada') }}</small>
          <small v-for="m in issues.body" :key="m" class="error">{{ m }}</small>
        </div>

        <!-- Os anexos: os escolhidos em cima, todos os que dá para anexar embaixo. -->
        <div v-show="tab === 'triggers'">
          <TriggersEditor
            v-model="form.triggers"
            id-prefix="resource-trigger"
            :title="kind === 'skill' ? 'Triggers da skill' : 'Triggers do command'"
            :intro="`O procedimento de uma situação dentro ${kind === 'skill' ? 'da skill' : 'do command'}. Carregado ${kind === 'skill' ? 'a skill' : 'o command'}, o agente vê só o nome e o &quot;quando&quot; de cada um, e carrega o procedimento (use_resource, id ${form.id || '<id>'}/<trigger>) quando a situação acontece.`"
            :empty="`Nenhum trigger. O que vale sempre fica nas instruções; o que vale numa situação vira um trigger.`"
            :issues="issues.triggers"
          />
        </div>
        <div v-show="tab === 'attachments'" class="flex flex-col gap-2">
          <AttachedDocs :attachable="attachable" :selected="form.docIds" :mode-of="attachMode" :empty-text="form.global ? 'Nenhum documento global.' : 'Nenhum documento global ou deste projeto.'" @toggle="toggleDoc" @mode="setMode" />
          <small class="hint">Inteiro: o texto vai junto toda vez. Por referência: vão só id, título e tamanho, e o agente lê com read_doc se precisar — para documento grande.</small>
          <small v-for="m in issues.docIds" :key="m" class="error">{{ m }}</small>
          <small v-for="m in issues.docRefs" :key="m" class="error">{{ m }}</small>
        </div>

        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
        <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
        <!-- Os arquivos também vão no Salvar (um salvar só por tela): a guia fica montada, com o rascunho dela. -->
        <div v-if="loaded" v-show="tab === 'files'">
          <ResourceFiles
            ref="filesPart"
            embedded
            :files="loaded.files ?? []"
            :where="`${loaded.projectId ? `projects/${loaded.projectId}` : 'global'}/${kind}s/${loaded.id}`"
            :save="saveFiles"
          />
        </div>
        </fieldset>
        <!-- ⚖️ As duas formas de variável do terminal, juntas: as fixas (texto, no registro do item, gravadas com o Salvar) e as
             secretas (cifradas; o valor só entra, gravado à parte). Chegam ao mesmo terminal; a secreta vence a fixa. -->
        <div v-if="loaded && tab === 'variables'" class="flex flex-col gap-3" data-test="resource-variables">
          <fieldset :disabled="locked" class="contents">
            <section class="tool-card">
              <header>
                <h3>Fixas</h3>
                <span class="count">{{ form.env.length || 'nenhuma' }} · salvas com o botão Salvar</span>
              </header>
              <div class="flex flex-col gap-2 p-3">
                <p class="hint">
                  Texto comum (endereço de um serviço, região): carregada {{ kind === 'command' ? 'o command' : 'a skill' }}, vão ao terminal do agente, por cima das do agente e
                  do projeto. Segredo não mora aqui: vai em Secretas, logo abaixo.
                </p>
                <div v-for="(row, index) in form.env" :key="index" class="flex flex-wrap items-center gap-2" data-test="resource-fixed-row">
                  <input v-model="row.name" class="input w-56 font-mono text-xs" placeholder="GRAFANA_URL" :aria-label="`Nome da variável ${index + 1}`" @keydown.enter.prevent />
                  <input v-model="row.value" class="input min-w-0 flex-1 font-mono text-xs" placeholder="valor" :aria-label="`Valor da variável ${index + 1}`" @keydown.enter.prevent />
                  <button type="button" class="btn btn-sm btn-danger" @click="form.env.splice(index, 1)">Remover</button>
                </div>
                <button type="button" class="btn btn-sm btn-ghost self-start" data-test="resource-fixed-add" @click="form.env.push({ name: '', value: '' })">+ Variável</button>
                <small v-for="name in envRepeated" :key="`dup-${name}`" class="error">{{ name }} aparece mais de uma vez</small>
                <small v-for="m in issues.env" :key="m" class="error" data-test="resource-fixed-error">{{ m }}</small>
              </div>
            </section>
          </fieldset>
          <section class="tool-card">
            <header>
              <h3>Secretas</h3>
              <span class="count">cifradas · cada uma é gravada na hora, à parte do Salvar</span>
            </header>
            <div class="p-3">
              <p v-if="sharedFrom" class="mb-2 text-sm text-sky-200" data-test="shared-secrets">Valores deste projeto (não vêm do projeto de origem)</p>
              <SecretVariables :base-path="`/resources/${encodeURIComponent(loaded.id)}`" :project="secretsProject" :scope-label="kind === 'command' ? 'deste command (valem depois que ele é carregado na conversa)' : 'desta skill (valem depois que ela é carregada na conversa)'" />
            </div>
          </section>
        </div>
        <SaveFooter v-if="!locked" submit :label="`${adding ? 'Criar' : 'Salvar'} ${info.one}`" :busy="busy" :disabled="!(dirty || !!filesPart?.dirty)" :pending="!adding && (dirty || !!filesPart?.dirty)">
          <RouterLink v-if="adding" :to="info.base" class="btn btn-ghost">Cancelar</RouterLink>
          <template v-if="!adding" #end>
            <button type="button" class="btn btn-danger" @click="removing = true">Apagar {{ info.one }}</button>
          </template>
        </SaveFooter>
      </form>
      <section v-else-if="loaded && tab === 'issues'" class="mx-auto flex max-w-3xl flex-col gap-3">
        <h2 class="font-mono text-lg font-semibold">{{ kind === 'command' ? '/' : '' }}{{ loaded.id }}</h2>
        <ImportIssues :issues="importIssues" :resolve="resolveIssue" />
      </section>
      <section v-else-if="loaded && tab === 'share' && canShare" class="mx-auto flex max-w-3xl flex-col gap-3">
        <h2 class="font-mono text-lg font-semibold">{{ kind === 'command' ? '/' : '' }}{{ loaded.id }}</h2>
        <ShareProjects :owner="loaded.projectId ?? ''" :shared="loaded.sharedWith ?? []" :save="saveShares" />
      </section>
      <section v-else-if="loaded && tab === 'history'" class="mx-auto flex max-w-3xl flex-col gap-3">
        <h2 class="font-mono text-lg font-semibold">{{ kind === 'command' ? '/' : '' }}{{ loaded.id }}</h2>
        <HistoryPanel :kind="kind" :id="loaded.id" :readonly="locked" @restored="restored" />
      </section>
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
.input:disabled {
  @apply opacity-60;
}
.tool-card {
  @apply rounded-xl border border-zinc-800;
}
.tool-card > header {
  @apply flex flex-wrap items-baseline gap-2 border-b border-zinc-800 px-3 py-2;
}
.tool-card h3 {
  @apply text-sm font-medium text-zinc-200;
}
.tool-card .count {
  @apply text-xs text-zinc-500;
}
</style>
