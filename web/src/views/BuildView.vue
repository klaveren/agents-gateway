<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import BuildTabs from '@/components/BuildTabs.vue'
import ThreadView from '@/components/ThreadView.vue'
import { api } from '@/lib/api'
import { BUILD_KINDS, builderAgentId, latestDraft, pendingDraft, type TBuildKind } from '@/lib/builder'
import { shortTime } from '@/lib/format'
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
const props = defineProps<{ kind: TBuildKind; tab: 'build' | 'protocol' }>()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const thread = useThreadStore()

const info = computed(() => BUILD_KINDS[props.kind])
const base = computed(() => info.value.base)
const title = computed(() => info.value.title)
const isDoc = computed(() => props.kind === 'spec' || props.kind === 'adr')
const isResource = computed(() => props.kind === 'skill' || props.kind === 'command')

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
/** O projeto da construção: o da conversa (o servidor o carimbou), senão o atual. */
const buildProject = computed(() => {
  const stamped = selectedBuild.value?.metadata?.project
  return typeof stamped === 'string' ? stamped : (projects.current ?? undefined)
})
const draft = computed(() => (selected.value && thread.sessionId === selected.value ? latestDraft(thread.turns) : undefined))
const draftPreview = ref(true)

async function loadBuilds() {
  if (!auth.isAdmin || props.tab !== 'build') return
  buildsError.value = undefined
  try {
    builds.value = (await api<{ sessions: IConversation[] }>('/conversations', { query: { builder: props.kind, limit: 50, ...projects.query } })).sessions
    // Aberta antes de a lista chegar (recarregou a página): o cabeçalho ganha o título agora.
    const open = builds.value.find((build) => build.id === selected.value)
    if (open && !thread.header) thread.setHeader(open)
  } catch (failure) {
    buildsError.value = describe(failure)
  }
}

watch(
  () => [props.kind, props.tab, projects.current] as const,
  () => void loadBuilds(),
  { immediate: true },
)
watch(
  selected,
  (id) => {
    if (id && thread.sessionId !== id) void thread.open(id, builds.value.find((build) => build.id === id))
  },
  { immediate: true },
)
// O título e o resumo da construção nascem no primeiro turno: relê a lista quando um turno termina.
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
    const { id } = await api<{ id: string }>('/sessions', { method: 'POST', body: { agentId: builderAgentId(props.kind), projectId: projects.current ?? undefined } })
    await router.replace({ query: { c: id } })
  } catch (failure) {
    buildsError.value = describe(failure)
  } finally {
    starting.value = false
  }
}

async function removed() {
  await router.replace({ query: {} })
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
  if (props.kind === 'rule') return void (await router.push(base.value))
  await router.push((await exists(current.id)) ? `${base.value}/${current.id}` : `${base.value}/new`)
}

/** O id já é um registro DESTE tipo? */
async function exists(id: string): Promise<boolean> {
  if (!id) return false
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
const currentProjectName = computed(() => projects.list.find((project) => project.id === projects.current)?.name ?? projects.current)

async function loadProtocol() {
  if (!auth.isAdmin || props.tab !== 'protocol') return
  protocolError.value = undefined
  try {
    const view = await api<IProtocolView>(`/protocols/${props.kind}`, { query: projects.query })
    protocol.value = view
    addenda.value = { global: view.addenda.global?.body ?? '', project: view.addenda.project?.body ?? '' }
  } catch (failure) {
    protocolError.value = describe(failure)
  }
}

watch(
  () => [props.kind, props.tab, projects.current] as const,
  () => void loadProtocol(),
  { immediate: true },
)

async function saveAddendum(scope: 'global' | 'project') {
  saving.value = scope
  saved.value = undefined
  protocolError.value = undefined
  try {
    await api(`/protocols/${props.kind}/addendum`, { method: 'PUT', body: { projectId: scope === 'project' ? projects.current : null, body: addenda.value[scope] } })
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

  <div v-else class="flex h-full min-h-0 flex-col">
    <header class="flex flex-wrap items-center gap-3 border-b border-zinc-800/80 px-4 py-3">
      <h1 class="text-xl font-semibold">{{ title }}</h1>
      <BuildTabs :kind="kind" :active="tab" />
    </header>

    <!-- CONSTRUIR: as construções, a conversa e o rascunho. -->
    <div v-if="tab === 'build'" class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside class="flex shrink-0 flex-col gap-1 border-b border-zinc-800/80 p-3 lg:w-64 lg:border-r lg:border-b-0">
        <button
          :disabled="starting"
          class="flex items-center justify-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
          @click="startBuild"
        >
          <Icon name="plus" class="h-4 w-4" />
          Nova construção
        </button>
        <p v-if="buildsError" class="px-1 text-xs text-rose-300">{{ buildsError }}</p>
        <p v-else-if="!builds.length" class="px-1 pt-2 text-xs text-zinc-500">Nenhuma construção{{ projects.current ? ' neste projeto' : '' }} ainda.</p>
        <div class="scroll-thin flex max-h-40 flex-col gap-0.5 overflow-y-auto lg:max-h-none">
          <RouterLink
            v-for="build in builds"
            :key="build.id"
            :to="{ query: { c: build.id } }"
            class="rounded-xl px-3 py-2"
            :class="build.id === selected ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'"
          >
            <span class="block truncate text-sm">{{ build.title || 'Construção' }}</span>
            <span class="block truncate text-xs text-zinc-500">{{ shortTime(build.updatedAt) }} · {{ build.turns }} turno(s)</span>
          </RouterLink>
        </div>
      </aside>

      <main class="flex min-h-[24rem] min-w-0 flex-1 flex-col">
        <ThreadView v-if="selected" :key="selected" embedded :agent-id="builderAgentId(kind)" mode="agent" @removed="removed" />
        <section v-else class="mx-auto flex max-w-xl flex-col gap-3 p-6 text-sm text-zinc-300">
          <h2 class="text-lg font-semibold text-zinc-100">Construir {{ info.article }}</h2>
          <p>
            O construtor é um agente do sistema que segue o
            <RouterLink :to="`${base}/protocol`" class="text-emerald-400 underline underline-offset-2">protocolo</RouterLink>
            de {{ info.title.toLowerCase() }}: entende o que você quer, confere o que já existe, procura as specs e ADRs relacionadas e pergunta o que faltar. No fim, entrega um
            rascunho ao lado.
          </p>
          <p class="text-zinc-400">
            Ele só grava quando você disser na conversa que pode. Se preferir ajustar à mão, "Abrir no editor" leva o rascunho para a guia Lista, sem salvar. A conversa fica
            aqui, fora da caixa de entrada, e o consumo entra no Uso como "Construtor".
          </p>
          <p class="text-xs text-zinc-500">O modelo dele se escolhe em Sistema → Modelo do construtor (sem escolha, o do Atlas).</p>
          <div>
            <button
              :disabled="starting"
              class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
              @click="startBuild"
            >
              Nova construção
            </button>
          </div>
        </section>
      </main>

      <aside v-if="selected" class="scroll-thin flex shrink-0 flex-col gap-3 overflow-y-auto border-t border-zinc-800/80 p-4 lg:w-[26rem] lg:border-t-0 lg:border-l">
        <h2 class="text-sm font-semibold text-zinc-200">Rascunho</h2>
        <p v-if="!draft" class="text-xs text-zinc-500">Ainda nenhum. Quando o construtor fechar {{ info.article }}, o rascunho aparece aqui.</p>
        <template v-else>
          <div>
            <p v-if="kind === 'rule'" class="text-base font-medium text-zinc-100">{{ draft.title }}</p>
            <template v-else>
              <p class="font-mono text-base text-zinc-100">{{ kind === 'command' ? '/' : '' }}{{ draft.id }}</p>
              <p v-if="isDoc" class="text-sm font-medium text-zinc-200">{{ draft.title }}</p>
              <p class="text-sm text-zinc-300">{{ isDoc ? draft.summary : draft.description }}</p>
            </template>
            <p class="mt-1 text-xs text-zinc-500">{{ draft.global ? 'Global — todos os projetos' : `Projeto ${buildProject ?? '—'}` }}</p>
          </div>
          <p v-if="draft.saved" class="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            <Icon name="check" class="h-4 w-4" /> Salvo pelo construtor.
            <RouterLink :to="savedLink" class="ml-auto text-emerald-300 underline underline-offset-2">Abrir</RouterLink>
          </p>
          <div v-if="isResource && draft.docIds.length" class="flex flex-wrap gap-1">
            <span v-for="docId in draft.docIds" :key="docId" class="rounded-full bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300">{{ docId }}</span>
          </div>
          <div class="flex gap-1 text-xs">
            <button
              type="button"
              class="rounded-full px-3 py-1"
              :class="draftPreview ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'"
              @click="draftPreview = true"
            >
              Prévia
            </button>
            <button
              type="button"
              class="rounded-full px-3 py-1"
              :class="!draftPreview ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'"
              @click="draftPreview = false"
            >
              Texto
            </button>
          </div>
          <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
          <div v-if="draftPreview" class="prose-agent rounded-xl border border-zinc-800 p-3 text-sm break-words" v-html="renderMarkdown(draft.body)" />
          <pre v-else class="rounded-xl border border-zinc-800 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-zinc-300">{{ draft.body }}</pre>
          <button
            class="rounded-full px-4 py-2 text-sm font-medium"
            :class="draft.saved ? 'text-zinc-300 hover:bg-zinc-800' : 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'"
            @click="openInEditor"
          >
            Abrir no editor
          </button>
          <p class="text-xs text-zinc-500">{{ draft.saved ? 'Para ajustar à mão.' : 'Diga na conversa que pode gravar, ou abra na guia Lista, preenchido e sem salvar.' }}</p>
        </template>
      </aside>
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
            <p class="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500">
              Vem com o gateway e se atualiza com ele. Não se edita: para acrescentar regras suas, use o complemento abaixo.
            </p>
            <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
            <div class="prose-agent px-4 py-3 text-sm break-words" v-html="renderMarkdown(protocol.core.body)" />
          </section>

          <section class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-4">
            <h2 class="font-semibold">Complemento global</h2>
            <p class="text-xs text-zinc-500">Vale em todos os projetos, depois do protocolo do sistema. Em conflito, vale o complemento. Vazio = sem complemento.</p>
            <textarea
              v-model="addenda.global"
              rows="6"
              class="input font-mono text-[13px]"
              placeholder="Ex.: a descrição é sempre em português; o id começa pelo domínio (infra-, api-…)."
            />
            <div class="flex items-center gap-3">
              <button
                :disabled="saving === 'global'"
                class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                @click="saveAddendum('global')"
              >
                Salvar
              </button>
              <span v-if="saved === 'global'" class="text-xs text-emerald-300">Salvo. Vale para as construções que começarem agora.</span>
              <span v-else-if="protocol.addenda.global" class="text-xs text-zinc-500">
                {{ shortTime(protocol.addenda.global.updatedAt) }} · {{ protocol.addenda.global.updatedBy }}
              </span>
            </div>
          </section>

          <section v-if="projects.current" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-4">
            <h2 class="font-semibold">Complemento do projeto {{ currentProjectName }}</h2>
            <p class="text-xs text-zinc-500">Só nas construções deste projeto, depois do global.</p>
            <textarea v-model="addenda.project" rows="6" class="input font-mono text-[13px]" />
            <div class="flex items-center gap-3">
              <button
                :disabled="saving === 'project'"
                class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                @click="saveAddendum('project')"
              >
                Salvar
              </button>
              <span v-if="saved === 'project'" class="text-xs text-emerald-300">Salvo. Vale para as construções que começarem agora.</span>
              <span v-else-if="protocol.addenda.project" class="text-xs text-zinc-500">
                {{ shortTime(protocol.addenda.project.updatedAt) }} · {{ protocol.addenda.project.updatedBy }}
              </span>
            </div>
          </section>
          <p v-else class="text-xs text-zinc-500">Escolha um projeto para ver e editar o complemento dele.</p>
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
