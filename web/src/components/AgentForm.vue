<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import { defaultLanes, findOrphans, isUsableProvider, pruneModels, pruneNatives, summarizeIssues } from '@/lib/agentForm'
import { useProvidersStore } from '@/stores/providers'
import { useProtocolsStore } from '@/stores/protocols'
import type { IAgentDetail, IAgentInput, ICatalogModel, TMode } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useMcpStore } from '@/stores/mcp'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps<{ agent?: IAgentDetail; creating: boolean }>()
const emit = defineEmits<{ saved: [id: string]; duplicate: [agent: IAgentDetail]; removed: [] }>()

const agents = useAgentsStore()
const providers = useProvidersStore()
const protocols = useProtocolsStore()
const mcp = useMcpStore()

/**
 * Providers e protocolos carregados: sem eles o formulário não sabe lanes, níveis nem nativas, e o Salvar
 * fica desligado (⚠️ antes ele salvava com o que estivesse na tela, que podia ser o provider errado).
 */
const ready = ref(false)
const loadError = ref<string>()
async function loadBase() {
  loadError.value = undefined
  try {
    await Promise.all([providers.load(), protocols.loaded ? undefined : protocols.load()])
    ready.value = true
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  }
}

/**
 * Os MCPs: por servidor ligado, "todas as ferramentas" (`mcp:<id>/*`) ou uma a uma (`mcp:<id>/<tool>`).
 * As ferramentas de cada servidor são lidas ao abrir o formulário.
 */
const mcpReady = ref(false)
onMounted(async () => {
  void loadBase()
  const loaded = await mcp.load().then(
    () => true,
    () => false,
  )
  await Promise.all(mcp.list.filter((server) => server.enabled).map((server) => mcp.loadTools(server.id).catch(() => [])))
  mcpReady.value = loaded
})
const mcpRef = (server: string, tool: string) => `mcp:${server}/${tool}`
const enabledMcp = computed(() => mcp.list.filter((server) => server.enabled))
function mcpOffered(entry: string): boolean {
  const [server, tool] = entry.slice(4).split('/')
  if (!enabledMcp.value.some((candidate) => candidate.id === server)) return false
  return tool === '*' || (mcp.tools[server] ?? []).some((candidate) => candidate.name === tool)
}
function toggleAllMcp(server: string) {
  const all = mcpRef(server, '*')
  if (form.value.allowedTools.includes(all)) form.value.allowedTools = form.value.allowedTools.filter((entry) => entry !== all)
  // "Todas" substitui as escolhidas uma a uma do mesmo servidor.
  else form.value.allowedTools = [...form.value.allowedTools.filter((entry) => !entry.startsWith(`mcp:${server}/`)), all]
}

/** Os providers configurados e ligados; um desligado só aparece se for o deste agente. */
const providerOptions = computed(() => providers.list.filter((provider) => provider.enabled || provider.id === form.value.provider))
const protocol = computed(() => protocols.protocolOf(form.value.provider) ?? form.value.provider)
const protocolInfo = computed(() => protocols.get(protocol.value))
const compatible = computed(() => !!providers.list.find((provider) => provider.id === form.value.provider)?.baseUrl)
/** ⚖️ Quem manda é o servidor (`GET /protocols`): assinatura só tem a lane agent (as APIs de chat exigem chave). */
const subscription = computed(() => !!protocolInfo.value?.subscription)
const lanesAllowed = computed<TMode[]>(() => protocolInfo.value?.lanes ?? ['chat', 'agent'])

/** As ferramentas nativas do SDK deste provider (pela família do protocolo), na ordem do risco. */
const RISK_ORDER = ['hosted', 'session', 'server-network', 'server-read', 'server-exec']
/** Os níveis que o protocolo deste provider aceita (Google: nenhum). */
const reasoningLevels = computed(() => protocolInfo.value?.reasoningLevels ?? [])

const natives = computed(() => agents.nativeTools.filter((tool) => tool.protocol === protocolInfo.value?.nativeFamily).sort((a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk)))
const RISK_LABEL: Record<string, string> = {
  hosted: 'no fornecedor',
  session: 'só a conversa',
  'server-network': 'rede deste servidor',
  'server-read': 'lê este servidor',
  'server-exec': 'escreve e executa neste servidor',
}
const RISK_CLASS: Record<string, string> = {
  hosted: 'bg-zinc-800 text-zinc-300',
  session: 'bg-zinc-800 text-zinc-300',
  'server-network': 'bg-amber-500/15 text-amber-300',
  'server-read': 'bg-amber-500/15 text-amber-300',
  'server-exec': 'bg-rose-500/15 text-rose-300',
}

/** Por que uma nativa não pode ser ligada aqui — ou nada, se pode. */
function nativeBlock(tool: { allowed: boolean; officialOnly: boolean }): string | undefined {
  if (!tool.allowed) return 'bloqueada no deploy — liberar em NATIVE_TOOLS_ENABLED'
  if (tool.officialOnly && compatible.value) return 'só no provider oficial'
  return undefined
}

/**
 * Os modelos que o agente PODE oferecer: os ativados no catálogo do provider escolhido. Sem nenhum
 * ativado, o formulário manda para Providers → Modelos.
 */
const enabledModels = ref<ICatalogModel[]>([])
const loadingModels = ref(false)
const modelSearch = ref('')
const visibleModels = computed(() => {
  const term = modelSearch.value.trim().toLowerCase()
  return enabledModels.value.filter((model) => !term || model.modelId.toLowerCase().includes(term) || model.label?.toLowerCase().includes(term))
})


/** Marca/desmarca; o primeiro marcado é o padrão (e "tornar padrão" o leva para o topo). */
function toggleModel(modelId: string) {
  const at = form.value.models.indexOf(modelId)
  if (at === -1) form.value.models.push(modelId)
  else form.value.models.splice(at, 1)
}

function makeDefault(modelId: string) {
  form.value.models = [modelId, ...form.value.models.filter((model) => model !== modelId)]
}

/** Ferramentas que mudam algo fora da conversa: quem diz é o servidor (`dangerous` em `GET /tools`). */
const dangerousNames = computed(() => new Set(agents.tools.filter((tool) => tool.dangerous).map((tool) => tool.name)))
const dangerousChosen = computed(() => form.value.allowedTools.filter((name) => dangerousNames.value.has(name)))
const dangerousNative = computed(() => form.value.allowedTools.some((id) => natives.value.some((tool) => tool.id === id && tool.dangerous)))

/** O nome que a pessoa vê de cada campo, para o resumo do erro perto do Salvar. */
const FIELD_LABEL: Record<string, string> = {
  id: 'Id',
  name: 'Nome',
  provider: 'Provider',
  models: 'Modelos',
  modes: 'Lanes',
  reasoningEfforts: 'Raciocínio',
  allowedTools: 'Ferramentas',
  soul: 'Soul',
  systemPrompt: 'Prompt',
  role: 'Só subagente',
}

const blank = (): IAgentInput => ({ id: '', name: '', provider: '', soul: '', systemPrompt: '', models: [], reasoningEfforts: [], modes: ['chat', 'agent'], allowedTools: [], role: null })
const form = ref<IAgentInput>(blank())

/** Entradas `sdk:`/`agent:`/`mcp:` que nenhuma lista oferece: sem checkbox, mas o servidor recusa o salvamento. */
const orphans = computed(() =>
  findOrphans(form.value.allowedTools, {
    natives: agents.toolsLoaded && protocols.loaded ? new Set(natives.value.map((tool) => tool.id)) : undefined,
    agents: agents.loaded ? new Set(agents.list.filter((candidate) => candidate.id !== form.value.id).map((candidate) => candidate.id)) : undefined,
    mcp: mcpReady.value ? mcpOffered : undefined,
  }),
)

/** Modelos que o agente declarava e que estão desligados no catálogo: saem ao salvar. */
const droppedModels = ref<string[]>([])
const issues = ref<Record<string, string[]>>({})
const failure = ref<string>()
const saving = ref(false)
const confirmingSave = ref(false)
const confirming = ref(false)
const deleting = ref(false)

/** O padrão de um agente novo: o primeiro provider que já abre conversa (ligado, com chave ou assinatura). */
const defaultProvider = computed(() => providers.list.find((provider) => isUsableProvider(provider, protocols.get(provider.protocol)))?.id ?? '')
function applyDefaultProvider() {
  if (props.creating && !props.agent && !form.value.provider && defaultProvider.value) selectProvider(defaultProvider.value)
}
watch(defaultProvider, applyDefaultProvider)

// Só a troca feita pela pessoa poda os modelos: carregar um agente existente não pode mexer no que ele declara.
let userChanged = false
/** ⚠️ Cada troca de provider vale uma geração: a resposta de uma anterior chega depois e é descartada. */
let generation = 0

/**
 * A pessoa escolheu outro provider. Os modelos saem quando o catálogo novo chega (watcher abaixo); o resto
 * é decidido já: a nativa `sdk:` de outra família (claude-sub usa as do claude) e a lane que o protocolo
 * não aceita fariam o servidor recusar, e a busca e o aviso de modelos descartados eram do provider anterior.
 */
function selectProvider(id: string) {
  if (id === form.value.provider) return
  userChanged = true
  const next = providers.list.find((provider) => provider.id === id)?.protocol ?? id
  const info = protocols.get(next)
  modelSearch.value = ''
  droppedModels.value = []
  form.value.provider = id
  form.value.modes = defaultLanes(info)
  form.value.reasoningEfforts = protocols.levelsFor(next, form.value.reasoningEfforts ?? [])
  if (agents.toolsLoaded) form.value.allowedTools = pruneNatives(form.value.allowedTools, agents.nativeTools, info?.nativeFamily)
}

watch(
  () => form.value.provider,
  async (provider) => {
    const token = ++generation
    if (!provider) {
      enabledModels.value = []
      loadingModels.value = false
      return
    }
    loadingModels.value = true
    let models: ICatalogModel[]
    try {
      models = (await providers.models(provider)).filter((model) => model.enabled)
    } catch {
      models = []
    }
    // ⚠️ Resposta de um provider que já não é o escolhido (troca rápida, ou outro agente aberto): ignora.
    if (token !== generation) return
    enabledModels.value = models
    loadingModels.value = false
    // ⚠️ TROCOU O PROVIDER: os modelos do anterior não existem neste. Mantê-los marcados fazia o servidor
    // recusar ("not enabled in Providers → Models") e a tela parecia "não salvar". Ficam só os que este
    // provider oferece; sem nenhum, o primeiro ativado vira o padrão.
    if (userChanged) {
      userChanged = false
      form.value.models = pruneModels(form.value.models, models.map((model) => model.modelId))
    }
  },
  { immediate: true },
)

const readOnly = computed(() => !!props.agent?.builtIn && !props.creating)

watch(
  () => [props.agent, props.creating] as const,
  ([agent]) => {
    userChanged = false
    modelSearch.value = ''
    form.value = agent ? { id: agent.id, name: agent.name, provider: agent.provider, soul: agent.soul ?? '', systemPrompt: agent.systemPrompt, models: [...agent.models], reasoningEfforts: [...(agent.reasoningEfforts ?? [])], modes: [...agent.modes], allowedTools: [...agent.allowedTools], role: agent.role ?? null } : blank()
    // Os desligados no catálogo não entram no formulário: salvar com eles seria recusado.
    droppedModels.value = agent?.disabledModels ?? []
    form.value.models = form.value.models.filter((model) => !droppedModels.value.includes(model))
    issues.value = {}
    failure.value = undefined
    applyDefaultProvider()
  },
  { immediate: true },
)

function toggle<T>(values: T[], value: T) {
  const at = values.indexOf(value)
  if (at === -1) values.push(value)
  else values.splice(at, 1)
}

function slugify() {
  if (!props.creating || form.value.id) return
  form.value.id = form.value.name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

/** O que será gravado, em uma linha, para a confirmação do Salvar. */
const saveSummary = computed(() => {
  const { models, modes, allowedTools } = form.value
  return `Provider ${protocols.providerName(form.value.provider)}, ${models.length} modelo(s)${models[0] ? ` (padrão ${models[0]})` : ''}, lanes ${modes.join(' + ') || 'nenhuma'}, ${allowedTools.length} ferramenta(s).`
})

async function save() {
  confirmingSave.value = false
  saving.value = true
  issues.value = {}
  failure.value = undefined
  try {
    const input: IAgentInput = { ...form.value, reasoningEfforts: protocols.levelsFor(protocol.value, form.value.reasoningEfforts ?? []) }
    const saved = await agents.save(input, props.creating)
    emit('saved', saved.id)
  } catch (error) {
    // ⚠️ Todo 422 vira resumo perto do Salvar: o campo com problema pode nem ter input na tela.
    if (error instanceof ApiError && error.status === 422) issues.value = error.fieldIssues
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!props.agent) return
  deleting.value = true
  try {
    await agents.remove(props.agent.id)
    confirming.value = false
    emit('removed')
  } catch (error) {
    // 409 `agent_in_use`: a mensagem do servidor diz quem ainda referencia o agente.
    failure.value = error instanceof Error ? error.message : String(error)
    confirming.value = false
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <form class="mx-auto flex max-w-3xl flex-col gap-5" @submit.prevent="confirmingSave = true">
    <div v-if="readOnly" class="flex items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm text-zinc-300">
      Agente embutido: declarado no código, só leitura. Para mudar, duplique e edite a cópia.
      <button type="button" class="ml-auto rounded-full bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700" @click="agent && emit('duplicate', agent)">Duplicar</button>
    </div>

    <fieldset :disabled="readOnly" class="grid gap-4 sm:grid-cols-2">
      <label class="field">
        <span>Nome</span>
        <input v-model="form.name" required maxlength="80" class="input" @blur="slugify" />
        <small v-for="message in issues.name" :key="message" class="error">{{ message }}</small>
      </label>
      <label class="field">
        <span>Id</span>
        <input v-model="form.id" :disabled="!creating" required pattern="[a-z0-9][a-z0-9-]{1,47}" class="input font-mono disabled:opacity-60" placeholder="meu-agente" />
        <small v-if="creating" class="hint">Fica na URL e nas conversas. Não muda depois.</small>
        <small v-for="message in issues.id" :key="message" class="error">{{ message }}</small>
      </label>

      <div class="field sm:col-span-2">
        <span>Provider</span>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="provider in providerOptions" :key="provider.id" type="button" class="chip" :class="{ on: form.provider === provider.id }" @click="selectProvider(provider.id)">
            {{ provider.name }}<span v-if="!provider.enabled" class="text-[10px] text-zinc-500"> desligado</span>
          </button>
          <span v-if="!providerOptions.length" class="text-sm text-zinc-500">{{ form.provider ? protocols.providerName(form.provider) : 'Nenhum provider pronto — configure em Providers.' }}</span>
        </div>
      </div>

      <div class="field sm:col-span-2">
        <span>Modelos <em class="font-normal text-zinc-500">— os ativados em Providers; o padrão é o que a conversa usa quando ninguém escolhe</em></span>
        <p v-if="droppedModels.length" class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-normal text-amber-200">
          Desligados no catálogo, saem ao salvar: <code>{{ droppedModels.join(', ') }}</code>. Para manter, ative em Providers → Modelos.
        </p>
        <p v-if="loadingModels" class="text-xs font-normal text-zinc-500">Carregando modelos…</p>
        <p v-else-if="!enabledModels.length" class="text-sm font-normal text-amber-300">
          Nenhum modelo ativado neste provider. <RouterLink to="/providers" class="underline">Ative em Providers → Modelos</RouterLink>.
        </p>
        <template v-else>
          <input v-if="enabledModels.length > 8" v-model="modelSearch" type="search" placeholder="Buscar modelo…" class="input text-sm" />
          <ul class="scroll-thin max-h-64 divide-y divide-zinc-800/70 overflow-y-auto rounded-lg border border-zinc-800">
            <li v-for="model in visibleModels" :key="model.modelId" class="flex items-center gap-3 px-3 py-2 font-normal">
              <input type="checkbox" class="accent-emerald-500" :checked="form.models.includes(model.modelId)" @change="toggleModel(model.modelId)" />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-mono text-[13px]">{{ model.modelId }}</span>
                <span v-if="model.price" class="text-xs text-zinc-500">${{ model.price.input }} / ${{ model.price.output }} por 1M</span>
              </span>
              <span v-if="form.models[0] === model.modelId" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">padrão</span>
              <button v-else-if="form.models.includes(model.modelId)" type="button" class="text-xs text-zinc-400 hover:text-zinc-100" @click="makeDefault(model.modelId)">tornar padrão</button>
            </li>
          </ul>
        </template>
        <small v-if="compatible" class="hint">Provider compatível: tool use e raciocínio variam por modelo.</small>
        <small v-for="message in issues.models" :key="message" class="error">{{ message }}</small>
      </div>

      <div class="field">
        <span>Lanes</span>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="mode in (['chat', 'agent'] as TMode[])"
            :key="mode"
            type="button"
            class="chip disabled:opacity-40"
            :class="{ on: form.modes.includes(mode) }"
            :disabled="!lanesAllowed.includes(mode) || (subscription && mode === 'chat')"
            @click="toggle(form.modes, mode)"
          >
            {{ mode === 'chat' ? 'Chat' : 'Agents SDK' }}
          </button>
        </div>
        <small v-if="subscription" class="hint">Assinatura: só a lane Agents SDK, e só quem administra conversa com este agente (a conta é pessoal).</small>
        <small v-for="message in issues.modes" :key="message" class="error">{{ message }}</small>
      </div>
      <div class="field">
        <span>Níveis de raciocínio</span>
        <div v-if="reasoningLevels.length" class="flex flex-wrap gap-1.5">
          <button v-for="level in reasoningLevels" :key="level" type="button" class="chip font-mono" :class="{ on: form.reasoningEfforts?.includes(level) }" @click="toggle((form.reasoningEfforts ??= []), level)">{{ level }}</button>
        </div>
        <small v-else class="hint">O SDK do Gemini usado aqui não controla o raciocínio; o modelo decide sozinho.</small>
        <small v-if="reasoningLevels.length" class="hint">Os que a conversa pode escolher. Modelo que não raciocina não mostra o seletor.</small>
        <small v-for="message in issues.reasoningEfforts" :key="message" class="error">{{ message }}</small>
      </div>

      <div class="field sm:col-span-2">
        <span>Ferramentas locais</span>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="tool in agents.tools"
            :key="tool.name"
            type="button"
            class="chip"
            :class="{ on: form.allowedTools.includes(tool.name), danger: tool.dangerous }"
            :title="tool.description"
            @click="toggle(form.allowedTools, tool.name)"
          >
            {{ tool.name }} <span class="text-[10px] text-zinc-500">{{ tool.origin }}</span>
          </button>
          <span v-if="!agents.tools.length" class="text-sm text-zinc-500">Nenhuma disponível.</span>
        </div>
        <small v-if="dangerousChosen.length" class="text-amber-300">⚠ {{ dangerousChosen.join(', ') }} alcança o servidor do gateway. Por isso, só administradores conversam com este agente (DANGEROUS_TOOLS_ADMIN_ONLY).</small>
        <small v-for="message in issues.allowedTools" :key="message" class="error">{{ message }}</small>
      </div>

      <div class="field sm:col-span-2">
        <span>Pode delegar a <em class="font-normal text-zinc-500">— outros agentes a quem este pede parte do trabalho (rodam com as permissões de quem conversa; até {{ agents.limits.delegationMaxDepth }} níveis, sem ciclos)</em></span>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="other in agents.list.filter((candidate) => candidate.id !== form.id)"
            :key="other.id"
            type="button"
            class="chip"
            :class="{ on: form.allowedTools.includes(`agent:${other.id}`) }"
            @click="toggle(form.allowedTools, `agent:${other.id}`)"
          >
            {{ other.name }}<span v-if="other.role === 'subagent'" class="ml-1 text-[10px] text-zinc-500">subagente</span>
          </button>
        </div>
        <small v-if="form.allowedTools.some((entry) => entry.startsWith('agent:')) && !form.modes.includes('agent')" class="hint">Na lane chat, a delegação só roda com o loop de ferramentas ligado.</small>
      </div>

      <div class="field sm:col-span-2">
        <span>MCPs <em class="font-normal text-zinc-500">— os servidores cadastrados em MCPs; o agente só vê o que for marcado aqui</em></span>
        <div v-if="enabledMcp.length" class="flex flex-col gap-2">
          <div v-for="server in enabledMcp" :key="server.id" class="rounded-xl border border-zinc-800 px-3 py-2 font-normal">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm text-zinc-200">{{ server.name }}</span>
              <code class="text-[11px] text-zinc-500">mcp:{{ server.id }}</code>
              <span v-if="!server.status.connected" class="text-[11px] text-amber-300">sem conexão</span>
              <label class="ml-auto flex items-center gap-1.5 text-xs text-zinc-400">
                <input type="checkbox" class="accent-emerald-500" :checked="form.allowedTools.includes(mcpRef(server.id, '*'))" @change="toggleAllMcp(server.id)" />
                Todas as ferramentas
              </label>
            </div>
            <div v-if="!form.allowedTools.includes(mcpRef(server.id, '*'))" class="mt-2 flex flex-wrap gap-1.5">
              <button
                v-for="tool in mcp.tools[server.id] ?? []"
                :key="tool.name"
                type="button"
                class="chip font-mono text-xs"
                :class="{ on: form.allowedTools.includes(mcpRef(server.id, tool.name)) }"
                :title="tool.description"
                @click="toggle(form.allowedTools, mcpRef(server.id, tool.name))"
              >
                {{ tool.name }}
              </button>
              <span v-if="!(mcp.tools[server.id] ?? []).length" class="text-xs text-zinc-500">Nenhuma ferramenta listada agora.</span>
            </div>
          </div>
        </div>
        <span v-else class="text-sm font-normal text-zinc-500">Nenhum MCP ligado. <RouterLink to="/mcp" class="text-emerald-400 hover:underline">Cadastrar em MCPs</RouterLink>.</span>
      </div>

      <div v-if="natives.length" class="field sm:col-span-2">
        <span>Ferramentas do SDK <em class="font-normal text-zinc-500">— só na lane Agents SDK</em></span>
        <p v-if="!form.modes.includes('agent')" class="text-xs font-normal text-amber-300">Este agente não tem a lane Agents SDK ligada: as ferramentas do SDK não serão usadas.</p>
        <ul class="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800">
          <li v-for="tool in natives" :key="tool.id" class="flex items-center gap-3 px-3 py-2 font-normal" :class="{ 'opacity-50': nativeBlock(tool) && !form.allowedTools.includes(tool.id) }">
            <input type="checkbox" class="accent-emerald-500" :checked="form.allowedTools.includes(tool.id)" :disabled="!!nativeBlock(tool) && !form.allowedTools.includes(tool.id)" @change="toggle(form.allowedTools, tool.id)" />
            <span class="min-w-0 flex-1">
              <span class="block text-sm">{{ tool.label }} <code class="text-[11px] text-zinc-500">{{ tool.sdkName }}</code></span>
              <span class="block text-xs text-zinc-500">{{ tool.description }}</span>
              <span v-if="nativeBlock(tool)" class="block text-xs text-zinc-500">{{ nativeBlock(tool) }}</span>
            </span>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-[10px]" :class="RISK_CLASS[tool.risk]">{{ RISK_LABEL[tool.risk] }}</span>
          </li>
        </ul>
        <small v-if="dangerousNative" class="text-amber-300">⚠ Ferramentas que tocam este servidor dão ao agente acesso ao disco, à rede ou a comandos daqui. Só administradores conversam com ele.</small>
      </div>

      <div v-if="orphans.length" class="field sm:col-span-2">
        <span>Órfãs <em class="font-normal text-zinc-500">— escolhidas, mas que este provider ou o servidor não oferecem; o servidor recusa o salvamento com elas</em></span>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="entry in orphans" :key="entry" type="button" class="chip on danger font-mono text-xs" title="Clique para tirar do agente" @click="toggle(form.allowedTools, entry)">
            <span class="mr-1 rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-200">órfão</span>{{ entry }} ✕
          </button>
        </div>
      </div>

      <div class="field sm:col-span-2">
        <label class="flex items-center gap-3">
          <button type="button" role="switch" :aria-checked="form.role === 'subagent'" class="switch" :class="{ on: form.role === 'subagent' }" @click="form.role = form.role === 'subagent' ? null : 'subagent'"><span /></button>
          <span>Só subagente</span>
        </label>
        <small class="hint">Só é chamado por outro agente (delegação, em "Pode delegar a"). Não aparece em Nova conversa e não abre conversa direta, nem pela API.</small>
      </div>

      <label class="field sm:col-span-2">
        <span>Soul <em class="font-normal text-zinc-500">— quem o agente é: identidade, tom, valores, jeito de falar. Vai para o modelo antes do prompt.</em></span>
        <textarea v-model="form.soul" rows="4" maxlength="8000" class="input scroll-thin text-[13px] leading-relaxed" placeholder="Você é a Íris: gentil, direta, explica sem jargão e admite quando não sabe." />
        <small v-for="message in issues.soul" :key="message" class="error">{{ message }}</small>
      </label>
      <label class="field sm:col-span-2">
        <span>Instrução do sistema <em class="font-normal text-zinc-500">— o que o agente faz: função, regras, como usar as ferramentas</em></span>
        <textarea v-model="form.systemPrompt" required rows="10" class="input scroll-thin font-mono text-[13px] leading-relaxed" placeholder="Você é o agente…" />
        <small v-if="protocol === 'google'" class="hint">Gemini (ADK): não use {chaves} — o ADK as lê como variável de sessão.</small>
        <small v-for="message in issues.systemPrompt" :key="message" class="error">{{ message }}</small>
      </label>
    </fieldset>

    <p v-if="failure && !Object.keys(issues).length" class="text-sm whitespace-pre-line text-rose-300">{{ failure }}</p>
    <!-- O erro de campo aparece junto do campo, que pode estar fora da tela: aqui, perto do Salvar, o resumo. -->
    <p v-else-if="Object.keys(issues).length" class="text-sm text-rose-300">
      Não salvou — corrija: {{ summarizeIssues(issues, FIELD_LABEL) }}
    </p>
    <p v-if="agent?.updatedBy" class="text-xs text-zinc-500">Alterado por {{ agent.updatedBy }} em {{ agent.updatedAt ? new Date(agent.updatedAt).toLocaleString('pt-BR') : '' }}</p>

    <p v-if="!readOnly && loadError" class="text-sm text-rose-300">
      Não consegui carregar os providers ({{ loadError }}), então não dá para salvar.
      <button type="button" class="underline hover:text-rose-200" @click="loadBase">Tentar de novo</button>
    </p>
    <p v-else-if="!readOnly && !ready" class="text-xs text-zinc-500">Carregando providers…</p>

    <div v-if="!readOnly" class="flex gap-2">
      <button type="submit" :disabled="saving || !ready || !!loadError || !form.provider" class="rounded-full bg-emerald-500 px-5 py-2 font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{{ saving ? 'Salvando…' : creating ? 'Criar agente' : 'Salvar' }}</button>
      <button v-if="!creating && agent" type="button" class="rounded-full bg-zinc-800 px-4 py-2 hover:bg-zinc-700" @click="emit('duplicate', agent)">Duplicar</button>
      <button v-if="!creating && agent" type="button" class="ml-auto rounded-full px-4 py-2 text-rose-300 hover:bg-rose-500/10" @click="confirming = true">Apagar</button>
    </div>
    <ConfirmDialog
      :open="confirmingSave"
      :title="`${creating ? 'Criar' : 'Salvar'} o agente ${form.name}?`"
      :message="saveSummary"
      :action="creating ? 'Criar' : 'Salvar'"
      tone="neutral"
      @confirm="save"
      @cancel="confirmingSave = false"
    />
    <ConfirmDialog
      :open="confirming"
      :title="`Apagar o agente ${agent?.name ?? ''}?`"
      message="Some da lista e nenhuma sessão nova nasce dele. As conversas gravadas continuam, e sessões abertas terminam com o agente com que nasceram."
      :busy="deleting"
      @confirm="remove"
      @cancel="confirming = false"
    />
  </form>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex flex-col gap-1.5 text-sm font-medium text-zinc-300;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
.hint {
  @apply text-xs font-normal text-zinc-500;
}
.error {
  @apply text-xs font-normal text-rose-300;
}
.chip {
  @apply rounded-full border border-zinc-700 px-3 py-1 text-sm font-normal text-zinc-300 hover:bg-zinc-800;
}
.chip.on {
  @apply border-emerald-500/60 bg-emerald-500/15 text-emerald-200;
}
.chip.danger.on {
  @apply border-amber-500/60 bg-amber-500/15 text-amber-200;
}
.switch {
  @apply relative h-6 w-11 shrink-0 rounded-full bg-zinc-700 transition-colors;
}
.switch span {
  @apply absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform;
}
.switch.on {
  @apply bg-emerald-500;
}
.switch.on span {
  @apply translate-x-5;
}
</style>
