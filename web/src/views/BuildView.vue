<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import BuildTabs from '@/components/BuildTabs.vue'
import ThreadView from '@/components/ThreadView.vue'
import { api } from '@/lib/api'
import { BUILD_KINDS, builderAgentId, latestDraft, pendingDraft, type TBuildKind } from '@/lib/builder'
import { shortTime, sizeHint } from '@/lib/format'
import { renderMarkdown } from '@/lib/markdown'
import type { IConversation, IProjectDoc, IResource } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useThreadStore } from '@/stores/thread'

/**
 * As guias CONSTRUIR e PROTOCOLO de Rules, Specs, ADRs, Skills e Commands (só admin).
 *
 * ⚖️ O protocolo do CORE chega com o gateway e não se edita aqui: quem administra só soma um complemento (global ou do
 * projeto), que vem depois dele. O construtor é um agente do core que segue os dois numa conversa guiada, entrega um
 * rascunho e grava quando a pessoa confirma na conversa; o rascunho também abre no editor da guia Lista.
 */
/**
 * `project`: o escopo FIXO — `null` = global (as rules globais, em Sistema), um id = aquele projeto (a guia do projeto).
 * Ausente = o projeto atual.
 */
const props = defineProps<{ kind: TBuildKind; tab: 'build' | 'protocol'; project?: string | null }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const thread = useThreadStore()

const info = computed(() => BUILD_KINDS[props.kind])
/** O projeto em que se constrói: o fixo, ou o atual. `undefined` = global. */
const scopeProject = computed(() => (props.project === undefined ? (projects.current ?? undefined) : (props.project ?? undefined)))
const base = computed(() => info.value.base)
const title = computed(() => (props.kind === 'rule' && props.project === null ? 'Rules globais' : info.value.title))
const isDoc = computed(() => props.kind === 'spec' || props.kind === 'adr' || props.kind === 'knowledge')
const isResource = computed(() => props.kind === 'skill' || props.kind === 'command')
const isAgent = computed(() => props.kind === 'agent')
/** Agente: "claude · claude-sonnet-5, haiku" por provider, para o painel. */
const agentProviders = computed(() => {
  const providers = draft.value?.agent?.providers
  if (!Array.isArray(providers)) return []
  return providers.map((target) => {
    const item = target as { provider?: unknown; models?: unknown }
    return `${String(item.provider ?? '?')} · ${Array.isArray(item.models) ? item.models.join(', ') : ''}`
  })
})
const agentTools = computed(() => (Array.isArray(draft.value?.agent?.allowedTools) ? (draft.value!.agent!.allowedTools as unknown[]).map(String) : []))
/** Agente: o que ele usa de skills e commands, em uma linha ("todos" é o padrão). */
const agentResources = computed(() => {
  const resources = draft.value?.resources
  const line = (ids?: string[]) => (!ids || ids.includes('*') ? 'todos' : ids.length ? ids.join(', ') : 'nenhum')
  return resources ? `Skills: ${line(resources.skills)} · Commands: ${line(resources.commands)}` : 'Skills e Commands: todos'
})

onMounted(async () => {
  if (!auth.isAdmin) return
  if (!projects.loaded) await projects.load().catch(() => undefined)
})

// ── Construir ────────────────────────────────────────────────────────────────

const builds = ref<IConversation[]>([])
const buildsError = ref<string>()
const starting = ref(false)
const selected = computed(() => (typeof route.query.c === 'string' && route.query.c ? route.query.c : undefined))
const selectedBuild = computed(() => builds.value.find((build) => build.id === selected.value))
/** O projeto da conversa com o construtor: o da conversa (o servidor o carimbou), senão o atual. */
const buildProject = computed(() => {
  const stamped = selectedBuild.value?.metadata?.project
  return typeof stamped === 'string' ? stamped : scopeProject.value
})
const draft = computed(() => (selected.value && thread.sessionId === selected.value ? latestDraft(thread.turns) : undefined))
const draftPreview = ref(true)

async function loadBuilds() {
  if (!auth.isAdmin || props.tab !== 'build') return
  buildsError.value = undefined
  try {
    const found = (
      await api<{ sessions: IConversation[] }>('/conversations', { query: { builder: props.kind, limit: 50, ...(scopeProject.value ? { project: scopeProject.value } : {}) } })
    ).sessions
    // Escopo global: só as conversas sem projeto (a busca sem `project` traria as de todos).
    builds.value = props.project === null ? found.filter((build) => !build.metadata?.project) : found
    // Aberta antes de a lista chegar (recarregou a página): o cabeçalho ganha o título agora.
    const open = builds.value.find((build) => build.id === selected.value)
    if (open && !thread.header) thread.setHeader(open)
  } catch (failure) {
    buildsError.value = describe(failure)
  }
}

watch(
  () => [props.kind, props.tab, scopeProject.value] as const,
  () => void loadBuilds(),
  { immediate: true },
)
watch(
  selected,
  (id) => {
    if (id && thread.sessionId !== id)
      void thread.open(
        id,
        builds.value.find((build) => build.id === id),
      )
  },
  { immediate: true },
)
// O título e o resumo da conversa nascem no primeiro turno: relê a lista quando um turno termina.
watch(
  () => thread.turns.length,
  () => {
    if (selected.value && thread.sessionId === selected.value) void loadBuilds()
  },
)
/**
 * ⚠️ O rascunho mora nos ARGUMENTOS da chamada, e eles só existem no turno GRAVADO: o do stream tem só o nome da
 * ferramenta. A gravação chega ao banco um pouco depois do fim do stream (às vezes depois da releitura de 600 ms da
 * conversa), então aqui se relê mais duas vezes depois de cada resposta.
 */
watch(
  () => thread.sending,
  (sending, was) => {
    if (sending || !was || !selected.value) return
    const id = selected.value
    for (const delay of [1500, 4000]) setTimeout(() => thread.sessionId === id && void thread.refresh(), delay)
  },
)

async function startBuild() {
  starting.value = true
  buildsError.value = undefined
  try {
    const { id } = await api<{ id: string }>('/sessions', { method: 'POST', body: { agentId: builderAgentId(props.kind), projectId: scopeProject.value } })
    // ⚠️ Preserva o resto da query: embutido (a guia do projeto), o `?tab=` é da tela que embute.
    await router.replace({ query: { ...route.query, c: id } })
  } catch (failure) {
    buildsError.value = describe(failure)
  } finally {
    starting.value = false
  }
}

async function removed() {
  const { c: _closed, ...rest } = route.query
  await router.replace({ query: rest })
  await loadBuilds()
}

/**
 * Leva o rascunho ao editor da guia Lista, preenchido e NÃO salvo: o id que já existe abre a edição dele. A rule não tem
 * id no rascunho — vai para o formulário de rule nova.
 */
async function openInEditor() {
  const current = draft.value
  if (!current) return
  const projectId = current.global ? undefined : buildProject.value
  pendingDraft.value = { ...current, kind: props.kind, ...(projectId ? { projectId } : {}) }
  // A rule vai para o formulário de rule nova da página Rules, no escopo dela.
  if (props.kind === 'rule') return void (await router.push(base.value))
  await router.push((await exists(current.id)) ? `${base.value}/${current.id}` : `${base.value}/new`)
}

/** O id já é um registro DESTE tipo? */
async function exists(id: string): Promise<boolean> {
  if (!id) return false
  if (isAgent.value)
    return api(`/agents/${encodeURIComponent(id)}`)
      .then(() => true)
      .catch(() => false)
  const path = isDoc.value ? `/docs/${encodeURIComponent(id)}` : `/resources/${encodeURIComponent(id)}`
  return api<IProjectDoc | IResource>(path)
    .then((item) => item.kind === props.kind)
    .catch(() => false)
}

/** Onde o registro gravado pelo construtor aparece. */
const savedLink = computed(() => (props.kind === 'rule' || !draft.value?.id ? base.value : `${base.value}/${draft.value.id}`))

// ── Protocolo ────────────────────────────────────────────────────────────────

interface IAddendum {
  body: string
  updatedAt: string
  updatedBy?: string
}
interface IProtocolView {
  core: { kind: TBuildKind; version: string; title: string; body: string }
  addenda: { global?: IAddendum; project?: IAddendum }
}

const protocol = ref<IProtocolView>()
const protocolError = ref<string>()
const addenda = ref({ global: '', project: '' })
const saving = ref<'global' | 'project'>()
const saved = ref<'global' | 'project'>()
const currentProjectName = computed(() => projects.list.find((project) => project.id === scopeProject.value)?.name ?? scopeProject.value)

async function loadProtocol() {
  if (!auth.isAdmin || props.tab !== 'protocol') return
  protocolError.value = undefined
  try {
    const view = await api<IProtocolView>(`/protocols/${props.kind}`, { query: scopeProject.value ? { project: scopeProject.value } : {} })
    protocol.value = view
    addenda.value = { global: view.addenda.global?.body ?? '', project: view.addenda.project?.body ?? '' }
  } catch (failure) {
    protocolError.value = describe(failure)
  }
}

watch(
  () => [props.kind, props.tab, scopeProject.value] as const,
  () => void loadProtocol(),
  { immediate: true },
)

async function saveAddendum(scope: 'global' | 'project') {
  saving.value = scope
  saved.value = undefined
  protocolError.value = undefined
  try {
    await api(`/protocols/${props.kind}/addendum`, { method: 'PUT', body: { projectId: scope === 'project' ? scopeProject.value : null, body: addenda.value[scope] } })
    // A resposta é a do escopo gravado; relê no do projeto atual, para os dois complementos.
    await loadProtocol()
    saved.value = scope
  } catch (failure) {
    protocolError.value = describe(failure)
  } finally {
    saving.value = undefined
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra constrói {{ title }}.</p>
  </div>

  <!-- ⚖️ O título e as guias moram numa coluna à esquerda da largura da lista (340px), como em Lista: trocar de guia não
       mexe neles de lugar. Em Construir, a mesma coluna leva as conversas com o construtor. -->
  <div v-else class="flex h-full min-h-0 flex-col lg:flex-row">
    <aside class="scroll-thin flex shrink-0 flex-col border-b border-zinc-800/80 lg:h-full lg:w-[340px] lg:overflow-y-auto lg:border-r lg:border-b-0">
      <!-- A altura do botão "+" das listas: o título não pula ao trocar de guia. -->
      <header class="flex h-9 box-content items-center gap-2 px-4 pt-4 pb-3">
        <h1 class="text-xl font-semibold">{{ title }}</h1>
      </header>
      <BuildTabs :kind="kind" :active="tab" class="px-3 pb-2" />
      <div v-if="tab === 'build'" class="flex flex-col gap-1 px-3 pt-1 pb-3">
        <button
          :disabled="starting"
          class="btn btn-primary"
          @click="startBuild"
        >
          <Icon name="plus" class="h-4 w-4" />
          Criar com o construtor
        </button>
        <p v-if="buildsError" class="px-1 text-xs text-rose-300">{{ buildsError }}</p>
        <h2 v-else-if="builds.length" class="px-1 pt-3 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Conversas com o construtor</h2>
        <p v-else class="px-1 pt-2 text-xs text-zinc-500">Nenhuma conversa com o construtor{{ scopeProject ? ' neste projeto' : '' }} ainda.</p>
        <div class="scroll-thin flex max-h-32 flex-col gap-0.5 overflow-y-auto lg:max-h-none">
          <RouterLink
            v-for="build in builds"
            :key="build.id"
            :to="{ query: { ...route.query, c: build.id } }"
            class="rounded-xl px-3 py-2"
            :class="build.id === selected ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'"
          >
            <span class="block truncate text-sm">{{ build.title || 'Conversa com o construtor' }}</span>
            <span class="block truncate text-xs text-zinc-500">{{ shortTime(build.updatedAt) }} · {{ build.turns }} mensagem(ns)</span>
          </RouterLink>
        </div>
      </div>
    </aside>

    <!-- CONSTRUIR: a conversa aberta e o rascunho. ⚖️ Lado a lado só quando o PRÓPRIO espaço é largo (container query). -->
    <div v-if="tab === 'build'" class="@container min-h-0 min-w-0 flex-1">
      <div class="scroll-thin flex h-full min-h-0 flex-col overflow-y-auto @3xl:flex-row @3xl:overflow-hidden">
        <main class="flex min-h-[30rem] min-w-0 flex-1 flex-col @3xl:min-h-0">
          <ThreadView v-if="selected" :key="selected" embedded :agent-id="builderAgentId(kind)" mode="agent" @removed="removed" />
          <section v-else class="mx-auto flex max-w-xl flex-col gap-3 p-6 text-sm text-zinc-300">
            <h2 class="text-lg font-semibold text-zinc-100">Construir {{ info.article }}</h2>
            <p>
              O construtor segue o
              <RouterLink :to="`${base}/protocol`" class="text-emerald-400 underline underline-offset-2">protocolo</RouterLink>
              de {{ info.title.toLowerCase() }}: entende o que você quer, confere o que já existe e pergunta o que faltar. No fim, entrega um rascunho ao lado.
            </p>
            <p class="text-zinc-400">Ele só salva quando você autorizar na conversa. Para ajustar à mão, use "Abrir no editor".</p>
            <div>
              <button
                :disabled="starting"
                class="btn btn-primary"
                @click="startBuild"
              >
                Criar com o construtor
              </button>
            </div>
          </section>
        </main>

        <aside v-if="selected" class="scroll-thin flex shrink-0 flex-col gap-3 border-t border-zinc-800/80 p-4 @3xl:w-[22rem] @3xl:overflow-y-auto @3xl:border-t-0 @3xl:border-l">
          <h2 class="text-sm font-semibold text-zinc-200">Rascunho</h2>
          <p v-if="!draft" class="text-xs text-zinc-500">Ainda nenhum. Quando o construtor fechar {{ info.article }}, o rascunho aparece aqui.</p>
          <template v-else>
            <div>
              <p v-if="kind === 'rule'" class="text-base font-medium text-zinc-100">{{ draft.title }}</p>
              <template v-else-if="isAgent">
                <p class="text-base font-medium text-zinc-100">{{ draft.title }}</p>
                <p class="font-mono text-xs text-zinc-500">{{ draft.id }}</p>
                <p v-if="draft.description" class="mt-1 text-sm text-zinc-300 italic">{{ draft.description }}</p>
              </template>
              <template v-else>
                <p class="font-mono text-base text-zinc-100">{{ kind === 'command' ? '/' : '' }}{{ draft.id }}</p>
                <p v-if="isDoc" class="text-sm font-medium text-zinc-200">{{ draft.title }}</p>
                <p class="text-sm text-zinc-300">{{ isDoc ? draft.summary : draft.description }}</p>
              </template>
              <p class="mt-1 text-xs text-zinc-500">
                {{ draft.global ? 'Global — todos os projetos' : `Projeto ${projects.list.find((item) => item.id === buildProject)?.name ?? buildProject ?? '—'}` }}
              </p>
            </div>
            <p v-if="draft.saved" class="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
              <Icon name="check" class="h-4 w-4" />
              Salvo pelo construtor.
              <RouterLink :to="savedLink" class="ml-auto text-emerald-300 underline underline-offset-2">Abrir</RouterLink>
            </p>
            <dl v-if="isAgent" class="flex flex-col gap-1.5 text-xs">
              <div>
                <dt class="text-zinc-500">Modelos</dt>
                <dd v-for="line in agentProviders" :key="line" class="font-mono text-zinc-300">{{ line }}</dd>
              </div>
              <div v-if="agentTools.length">
                <dt class="text-zinc-500">Ferramentas</dt>
                <dd class="mt-0.5 flex flex-wrap gap-1">
                  <span v-for="tool in agentTools" :key="tool" class="rounded-full bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300">{{ tool }}</span>
                </dd>
              </div>
              <div v-if="draft.initialContext.length">
                <dt class="text-zinc-500">Contexto inicial</dt>
                <dd class="font-mono text-zinc-300">{{ draft.initialContext.join(', ') }}</dd>
              </div>
              <div>
                <dt class="text-zinc-500">Recursos</dt>
                <dd class="text-zinc-300">{{ agentResources }}</dd>
              </div>
              <div class="flex flex-wrap gap-1">
                <span v-if="draft.agent?.adminOnly" class="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300">só admin</span>
                <span v-if="draft.agent?.role === 'subagent'" class="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300">subagente</span>
              </div>
            </dl>
            <div v-if="draft.docIds.length" class="flex flex-wrap gap-1">
              <span v-for="docId in draft.docIds" :key="docId" class="rounded-full bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                {{ docId }}<template v-if="draft.docRefs.includes(docId)"> · ref</template>
              </span>
            </div>
            <div class="flex gap-1 text-xs">
              <button
                type="button"
                class="btn btn-sm"
                :class="draftPreview ? 'btn-secondary' : 'btn-ghost'"
                @click="draftPreview = true"
              >
                Prévia
              </button>
              <button
                type="button"
                class="btn btn-sm"
                :class="!draftPreview ? 'btn-secondary' : 'btn-ghost'"
                @click="draftPreview = false"
              >
                Texto
              </button>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
            <div v-if="draftPreview" class="prose-agent rounded-xl border border-zinc-800 p-3 text-sm break-words" v-html="renderMarkdown(draft.body)" />
            <pre v-else class="rounded-xl border border-zinc-800 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-zinc-300">{{ draft.body }}</pre>
            <button
              class="btn"
              :class="draft.saved ? 'btn-ghost' : 'btn-primary'"
              @click="openInEditor"
            >
              Abrir no editor
            </button>
            <p class="text-xs text-zinc-500">{{ draft.saved ? 'Para ajustar à mão.' : 'Diga ao construtor para salvar, ou abra no editor.' }}</p>
          </template>
        </aside>
      </div>
    </div>

    <!-- PROTOCOLO: o do core, só leitura, e os complementos. -->
    <div v-else class="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
      <div class="mx-auto flex max-w-3xl flex-col gap-4">
        <p v-if="protocolError" class="text-sm text-rose-300">{{ protocolError }}</p>
        <template v-if="protocol">
          <section class="rounded-xl border border-zinc-800">
            <header class="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
              <h2 class="font-semibold">{{ protocol.core.title }}</h2>
              <span class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">do sistema · v{{ protocol.core.version }}</span>
            </header>
            <p class="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500">Padrão do sistema, não editável. Para acrescentar regras, use o complemento abaixo.</p>
            <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
            <div class="prose-agent px-4 py-3 text-sm break-words" v-html="renderMarkdown(protocol.core.body)" />
          </section>

          <section class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-4">
            <h2 class="font-semibold">Complemento global</h2>
            <p class="text-xs text-zinc-500">Vale em todos os projetos e prevalece sobre o protocolo.</p>
            <textarea
              v-model="addenda.global"
              rows="6"
              class="input font-mono text-[13px]"
              placeholder="Ex.: a descrição é sempre em português; o id começa pelo tema (infra-, api-…)."
            />
            <small v-if="addenda.global" class="hint">{{ sizeHint(addenda.global, 'em cada conversa do construtor') }}</small>
            <div class="flex items-center gap-3">
              <button
                :disabled="saving === 'global'"
                class="btn btn-primary"
                @click="saveAddendum('global')"
              >
                Salvar
              </button>
              <span v-if="saved === 'global'" class="text-xs text-emerald-300">Salvo. Vale para as próximas conversas.</span>
              <span v-else-if="protocol.addenda.global" class="text-xs text-zinc-500">
                {{ shortTime(protocol.addenda.global.updatedAt) }} · {{ protocol.addenda.global.updatedBy }}
              </span>
            </div>
          </section>

          <section v-if="scopeProject" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-4">
            <h2 class="font-semibold">Complemento do projeto {{ currentProjectName }}</h2>
            <p class="text-xs text-zinc-500">Vale só neste projeto.</p>
            <textarea v-model="addenda.project" rows="6" class="input font-mono text-[13px]" />
            <small v-if="addenda.project" class="hint">{{ sizeHint(addenda.project, 'em cada conversa do construtor') }}</small>
            <div class="flex items-center gap-3">
              <button
                :disabled="saving === 'project'"
                class="btn btn-primary"
                @click="saveAddendum('project')"
              >
                Salvar
              </button>
              <span v-if="saved === 'project'" class="text-xs text-emerald-300">Salvo. Vale para as próximas conversas.</span>
              <span v-else-if="protocol.addenda.project" class="text-xs text-zinc-500">
                {{ shortTime(protocol.addenda.project.updatedAt) }} · {{ protocol.addenda.project.updatedBy }}
              </span>
            </div>
          </section>
          <p v-else-if="project !== null" class="text-xs text-zinc-500">Escolha um projeto para ver e editar o complemento dele.</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
