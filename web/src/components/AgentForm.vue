<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import { defaultLanes, findOrphans, isUsableProvider, pruneModels, pruneNatives, summarizeIssues, unionLanes, unionLevels } from '@/lib/agentForm'
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
/**
 * ⚖️ Órfã de MCP é só a de um servidor que não existe ou está desligado — a mesma regra do servidor, que
 * não exige a ferramenta. A listagem que a tela recebe não prova que ela sumiu: o servidor pode estar fora
 * do ar, só listar dentro de uma conversa, ou (o MCP do próprio gateway) listar para a tela só as
 * ferramentas que não são de admin. As escolhidas e não listadas aparecem no servidor delas, marcadas.
 */
function mcpOffered(entry: string): boolean {
  const [server] = entry.slice(4).split('/')
  return enabledMcp.value.some((candidate) => candidate.id === server)
}
/** As ferramentas de um servidor na tela: as que ele lista agora e as escolhidas que ele não listou. */
function mcpChips(server: string): Array<{ name: string; description?: string; unlisted?: boolean }> {
  const listed = mcp.tools[server] ?? []
  const chosen = form.value.allowedTools
    .filter((entry) => entry.startsWith(`mcp:${server}/`) && !entry.endsWith('/*'))
    .map((entry) => entry.slice(`mcp:${server}/`.length))
    .filter((name) => !listed.some((tool) => tool.name === name))
  return [...listed, ...chosen.map((name) => ({ name, unlisted: true }))]
}
function toggleAllMcp(server: string) {
  const all = mcpRef(server, '*')
  if (form.value.allowedTools.includes(all)) form.value.allowedTools = form.value.allowedTools.filter((entry) => entry !== all)
  // "Todas" substitui as escolhidas uma a uma do mesmo servidor.
  else form.value.allowedTools = [...form.value.allowedTools.filter((entry) => !entry.startsWith(`mcp:${server}/`)), all]
}

/** Os providers configurados e ligados; um desligado só aparece se for deste agente. */
const providerOptions = computed(() => providers.list.filter((provider) => provider.enabled || chosen.value.includes(provider.id)))
/** Os providers do agente, na ordem — o primeiro é o padrão. */
const chosen = computed(() => form.value.providers.map((target) => target.provider))
/** Cada provider escolhido com o seu protocolo (o do banco) e o que o servidor diz dele (`GET /protocols`). */
const selected = computed(() =>
  form.value.providers.map((target) => {
    const protocol = protocols.protocolOf(target.provider) ?? target.provider
    const status = providers.list.find((provider) => provider.id === target.provider)
    const info = protocols.get(protocol)
    return { target, protocol, info, status, compatible: !!status?.baseUrl, official: protocol === target.provider && !info?.subscription }
  }),
)
const infos = computed(() => selected.value.map((entry) => entry.info))
/** ⚖️ Quem manda é o servidor (`GET /protocols`): assinatura só tem a lane agent (as APIs de chat exigem chave). */
const lanesAllowed = computed<TMode[]>(() => unionLanes(infos.value))
const anySubscription = computed(() => selected.value.some((entry) => entry.info?.subscription))
const anyCompatible = computed(() => selected.value.some((entry) => entry.compatible))
const anyGoogle = computed(() => selected.value.some((entry) => entry.protocol === 'google'))
const families = computed(() => [...new Set(selected.value.flatMap((entry) => (entry.info ? [entry.info.nativeFamily] : [])))])

/** As ferramentas nativas do SDK dos providers escolhidos (pela família do protocolo), na ordem do risco. */
const RISK_ORDER = ['hosted', 'session', 'server-network', 'server-read', 'server-exec']
/** Os níveis que algum protocolo escolhido aceita (Google: nenhum). Cada provider usa os do seu. */
const reasoningLevels = computed(() => unionLevels(infos.value))

const natives = computed(() => agents.nativeTools.filter((tool) => families.value.includes(tool.protocol)).sort((a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk)))
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

/** Por que uma nativa não pode ser ligada aqui — ou nada, se pode. Nos outros providers do agente ela não vai. */
function nativeBlock(tool: { allowed: boolean; officialOnly: boolean; protocol: string }): string | undefined {
  if (!tool.allowed) return 'bloqueada no deploy — liberar em NATIVE_TOOLS_ENABLED'
  if (tool.officialOnly && !selected.value.some((entry) => entry.official && entry.protocol === tool.protocol)) return 'só no provider oficial'
  return undefined
}
/** Em que providers do agente a nativa roda (os da família dela). */
function nativeWhere(tool: { protocol: string }): string {
  return selected.value
    .filter((entry) => entry.info?.nativeFamily === tool.protocol)
    .map((entry) => protocols.providerName(entry.target.provider))
    .join(', ')
}

/**
 * Os modelos que cada provider PODE oferecer ao agente: os ativados no catálogo dele. Sem nenhum ativado,
 * o formulário manda para Providers → Modelos.
 */
const catalogs = ref<Record<string, ICatalogModel[] | undefined>>({})
/** Os catálogos a caminho: o watcher dispara de novo antes de a resposta chegar. */
const fetching = new Set<string>()
const modelSearch = ref('')
function visibleModels(providerId: string): ICatalogModel[] {
  const term = modelSearch.value.trim().toLowerCase()
  return (catalogs.value[providerId] ?? []).filter((model) => !term || model.modelId.toLowerCase().includes(term) || model.label?.toLowerCase().includes(term))
}
const manyModels = computed(() => Object.values(catalogs.value).some((models) => (models?.length ?? 0) > 8))

/** Marca/desmarca; o primeiro marcado é o padrão daquele provider (e "tornar padrão" o leva para o topo). */
function toggleModel(target: { models: string[] }, modelId: string) {
  const at = target.models.indexOf(modelId)
  if (at === -1) target.models.push(modelId)
  else target.models.splice(at, 1)
}

function makeDefault(target: { models: string[] }, modelId: string) {
  target.models = [modelId, ...target.models.filter((model) => model !== modelId)]
}

/** O provider vira o padrão do agente: vai para o topo. */
function makeDefaultProvider(id: string) {
  const target = form.value.providers.find((candidate) => candidate.provider === id)
  if (target) form.value.providers = [target, ...form.value.providers.filter((candidate) => candidate !== target)]
}

/** Ferramentas que mudam algo fora da conversa: quem diz é o servidor (`dangerous` em `GET /tools`). */
const dangerousNames = computed(() => new Set(agents.tools.filter((tool) => tool.dangerous).map((tool) => tool.name)))
const dangerousChosen = computed(() => form.value.allowedTools.filter((name) => dangerousNames.value.has(name)))
const dangerousNative = computed(() => form.value.allowedTools.some((id) => natives.value.some((tool) => tool.id === id && tool.dangerous)))

/** O nome que a pessoa vê de cada campo, para o resumo do erro perto do Salvar. */
const FIELD_LABEL: Record<string, string> = {
  id: 'Id',
  name: 'Nome',
  providers: 'Providers',
  models: 'Modelos',
  modes: 'Lanes',
  reasoningEfforts: 'Raciocínio',
  allowedTools: 'Ferramentas',
  soul: 'Soul',
  systemPrompt: 'Prompt',
  role: 'Só subagente',
}

const blank = (): IAgentInput => ({ id: '', name: '', providers: [], soul: '', systemPrompt: '', reasoningEfforts: [], modes: ['chat', 'agent'], allowedTools: [], role: null })
const form = ref<IAgentInput>(blank())

/** Entradas `sdk:`/`agent:`/`mcp:` que nenhuma lista oferece: sem checkbox, mas o servidor recusa o salvamento. */
const orphans = computed(() =>
  findOrphans(form.value.allowedTools, {
    natives: agents.toolsLoaded && protocols.loaded ? new Set(natives.value.map((tool) => tool.id)) : undefined,
    agents: agents.loaded ? new Set(agents.list.filter((candidate) => candidate.id !== form.value.id).map((candidate) => candidate.id)) : undefined,
    mcp: mcpReady.value ? mcpOffered : undefined,
  }),
)

/** Modelos que o agente declarava e que estão desligados no catálogo, por provider: saem ao salvar. */
const droppedModels = ref<Record<string, string[]>>({})
const dropped = computed(() => Object.entries(droppedModels.value).filter(([, models]) => models.length))
const issues = ref<Record<string, string[]>>({})
const failure = ref<string>()
const saving = ref(false)
const confirmingSave = ref(false)
const confirming = ref(false)
const deleting = ref(false)

/**
 * As guias do formulário: o texto do agente na primeira, e cada grupo de capacidades na sua. A contagem diz
 * quanto está escolhido sem abrir a guia; o ponto vermelho, que o servidor recusou algo ali.
 */
type TTab = 'agente' | 'modelos' | 'ferramentas' | 'mcps' | 'sdk'
const tab = ref<TTab>('agente')
const TAB_FIELDS: Record<TTab, string[]> = {
  agente: ['id', 'name', 'soul', 'systemPrompt', 'role'],
  modelos: ['providers', 'models', 'modes', 'reasoningEfforts'],
  ferramentas: ['allowedTools'],
  mcps: [],
  sdk: [],
}
const tabs = computed(() => {
  const tools = form.value.allowedTools
  const alert = (id: TTab) => (TAB_FIELDS[id].some((field) => issues.value[field]?.length) ? 'O servidor recusou algo nesta guia' : undefined)
  const all: Array<{ id: TTab; label: string; count?: number; alert?: string }> = [
    { id: 'agente', label: 'Agente', alert: alert('agente') },
    { id: 'modelos', label: 'Modelos', count: form.value.providers.reduce((total, target) => total + target.models.length, 0), alert: alert('modelos') },
    {
      id: 'ferramentas',
      label: 'Ferramentas',
      count: tools.filter((entry) => !entry.startsWith('mcp:') && !entry.startsWith('sdk:')).length,
      alert: alert('ferramentas') ?? (orphans.value.length ? 'Há ferramentas órfãs' : undefined),
    },
    { id: 'mcps', label: 'MCPs', count: tools.filter((entry) => entry.startsWith('mcp:')).length },
    { id: 'sdk', label: 'SDK', count: tools.filter((entry) => entry.startsWith('sdk:')).length },
  ]
  // Sem nativa para os providers escolhidos, a guia do SDK não tem o que mostrar.
  return all.filter((item) => item.id !== 'sdk' || natives.value.length || item.count)
})
// A guia que sumiu (tirou o provider das nativas) não fica aberta vazia.
watch(tabs, (list) => {
  if (!list.some((item) => item.id === tab.value)) tab.value = 'agente'
})

/** O padrão de um agente novo: o primeiro provider que já abre conversa (ligado, com chave ou assinatura). */
const defaultProvider = computed(() => providers.list.find((provider) => isUsableProvider(provider, protocols.get(provider.protocol)))?.id ?? '')
function applyDefaultProvider() {
  if (props.creating && !props.agent && !form.value.providers.length && defaultProvider.value) toggleProvider(defaultProvider.value)
}
watch(defaultProvider, applyDefaultProvider)

/**
 * Os providers que a PESSOA acabou de pôr: quando o catálogo deles chega, o primeiro modelo ativado vira o
 * padrão. Carregar um agente existente não pode mexer no que ele declara.
 */
const added = new Set<string>()

/**
 * A pessoa pôs ou tirou um provider.
 *
 * Pôr: entra no fim (o primeiro continua o padrão); os modelos chegam com o catálogo (watcher abaixo). Sendo
 * o único, as lanes e os níveis partem do protocolo dele.
 *
 * Tirar: o que só ele sustentava sai já — a nativa `sdk:` de uma família que ficou sem provider, a lane e o
 * nível que nenhum protocolo restante aceita fariam o servidor recusar.
 */
function toggleProvider(id: string) {
  const existing = form.value.providers.find((target) => target.provider === id)
  if (existing) {
    form.value.providers = form.value.providers.filter((target) => target !== existing)
    added.delete(id)
    delete droppedModels.value[id]
  } else {
    form.value.providers = [...form.value.providers, { provider: id, models: [] }]
    added.add(id)
    if (form.value.providers.length === 1) {
      const info = protocols.get(protocols.protocolOf(id) ?? id)
      form.value.modes = defaultLanes(info)
      form.value.reasoningEfforts = protocols.levelsFor(info?.id ?? id, form.value.reasoningEfforts ?? [])
    }
  }
  const lanes = lanesAllowed.value
  form.value.modes = form.value.modes.filter((mode) => lanes.includes(mode))
  if (!form.value.modes.length) form.value.modes = [...lanes]
  if (existing) {
    const levels = reasoningLevels.value
    form.value.reasoningEfforts = (form.value.reasoningEfforts ?? []).filter((level) => levels.includes(level))
    if (agents.toolsLoaded && protocols.loaded) form.value.allowedTools = pruneNatives(form.value.allowedTools, agents.nativeTools, families.value)
  }
}

watch(
  chosen,
  (ids) => {
    // Em paralelo: um catálogo lento (o do Google lista centenas) não segura o dos outros.
    for (const id of ids) {
      if (catalogs.value[id] !== undefined) {
        settleAdded(id)
        continue
      }
      if (fetching.has(id)) continue
      fetching.add(id)
      void providers
        .models(id)
        .then(
          (models) => models.filter((model) => model.enabled),
          () => [] as ICatalogModel[],
        )
        .then((models) => {
          fetching.delete(id)
          catalogs.value = { ...catalogs.value, [id]: models }
          settleAdded(id)
        })
    }
  },
  { immediate: true },
)

/** O catálogo de um provider que a pessoa acabou de pôr chegou: o primeiro ativado vira o padrão dele. */
function settleAdded(id: string) {
  if (!added.has(id)) return
  const target = form.value.providers.find((candidate) => candidate.provider === id)
  const offered = catalogs.value[id]
  if (!target || !offered) return
  added.delete(id)
  target.models = pruneModels(target.models, offered.map((model) => model.modelId))
}

watch(
  () => [props.agent, props.creating] as const,
  ([agent]) => {
    added.clear()
    modelSearch.value = ''
    // Os desligados no catálogo não entram no formulário: salvar com eles seria recusado.
    droppedModels.value = Object.fromEntries((agent?.providers ?? []).map((provider) => [provider.id, provider.disabledModels ?? []]))
    form.value = agent
      ? {
          id: agent.id,
          name: agent.name,
          providers: agent.providers.map((provider) => ({ provider: provider.id, models: provider.models.filter((model) => !provider.disabledModels?.includes(model)) })),
          soul: agent.soul ?? '',
          systemPrompt: agent.systemPrompt,
          reasoningEfforts: [...(agent.reasoningEfforts ?? [])],
          modes: [...agent.modes],
          allowedTools: [...agent.allowedTools],
          role: agent.role ?? null,
        }
      : blank()
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
  const { providers: targets, modes, allowedTools } = form.value
  const list = targets.map((target, index) => `${protocols.providerName(target.provider)} (${target.models.length} modelo(s)${index === 0 && target.models[0] ? `, padrão ${target.models[0]}` : ''})`)
  return `${targets.length > 1 ? 'Providers' : 'Provider'} ${list.join(', ') || 'nenhum'}; lanes ${modes.join(' + ') || 'nenhuma'}; ${allowedTools.length} ferramenta(s).`
})

async function save() {
  confirmingSave.value = false
  saving.value = true
  issues.value = {}
  failure.value = undefined
  try {
    const input: IAgentInput = { ...form.value, reasoningEfforts: (form.value.reasoningEfforts ?? []).filter((level) => reasoningLevels.value.includes(level)) }
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
  <form class="mx-auto flex max-w-3xl flex-col gap-5" @submit.prevent="confirmingSave = true" @invalid.capture="tab = 'agente'">
    <nav class="flex flex-wrap gap-1 border-b border-zinc-800" role="tablist">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        role="tab"
        :aria-selected="tab === item.id"
        class="-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm"
        :class="tab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
        @click="tab = item.id"
      >
        {{ item.label }}
        <span v-if="item.count" class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">{{ item.count }}</span>
        <span v-if="item.alert" class="h-1.5 w-1.5 rounded-full bg-rose-400" :title="item.alert" />
      </button>
    </nav>
    <fieldset v-show="tab === 'agente'" class="grid gap-4 sm:grid-cols-2">
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
        <small v-if="anyGoogle" class="hint">Gemini (ADK): não use {chaves} — o ADK as lê como variável de sessão.</small>
        <small v-for="message in issues.systemPrompt" :key="message" class="error">{{ message }}</small>
      </label>
    </fieldset>
    <fieldset v-show="tab === 'modelos'" class="grid gap-4 sm:grid-cols-2">
      <div class="field sm:col-span-2">
        <span>Providers <em class="font-normal text-zinc-500">— onde o agente roda; a conversa troca entre eles no meio. O primeiro é o padrão.</em></span>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="provider in providerOptions" :key="provider.id" type="button" class="chip" :class="{ on: chosen.includes(provider.id) }" @click="toggleProvider(provider.id)">
            {{ provider.name }}<span v-if="chosen[0] === provider.id" class="ml-1 text-[10px] text-emerald-300">padrão</span><span v-if="!provider.enabled" class="text-[10px] text-zinc-500"> desligado</span>
          </button>
          <span v-if="!providerOptions.length" class="text-sm text-zinc-500">{{ chosen.length ? chosen.map((id) => protocols.providerName(id)).join(', ') : 'Nenhum provider pronto — configure em Providers.' }}</span>
        </div>
        <small v-for="message in issues.providers" :key="message" class="error">{{ message }}</small>
      </div>

      <div v-if="form.providers.length" class="field sm:col-span-2">
        <span>Modelos <em class="font-normal text-zinc-500">— os ativados em Providers; o padrão é o que a conversa usa quando ninguém escolhe</em></span>
        <p v-if="dropped.length" class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-normal text-amber-200">
          Desligados no catálogo, saem ao salvar:
          <template v-for="([providerId, models], index) in dropped" :key="providerId">{{ index ? '; ' : '' }}{{ protocols.providerName(providerId) }}: <code>{{ models.join(', ') }}</code></template>. Para manter, ative em Providers → Modelos.
        </p>
        <input v-if="manyModels" v-model="modelSearch" type="search" placeholder="Buscar modelo…" class="input text-sm" />
        <div v-for="(target, index) in form.providers" :key="target.provider" class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2 text-xs font-normal">
            <span class="font-medium text-zinc-200">{{ protocols.providerName(target.provider) }}</span>
            <span v-if="index === 0" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">provider padrão</span>
            <button v-else type="button" class="text-zinc-400 hover:text-zinc-100" @click="makeDefaultProvider(target.provider)">tornar padrão</button>
          </div>
          <p v-if="catalogs[target.provider] === undefined" class="text-xs font-normal text-zinc-500">Carregando modelos…</p>
          <p v-else-if="!catalogs[target.provider]?.length" class="text-sm font-normal text-amber-300">
            Nenhum modelo ativado neste provider. <RouterLink to="/providers" class="underline">Ative em Providers → Modelos</RouterLink>.
          </p>
          <ul v-else class="scroll-thin max-h-64 divide-y divide-zinc-800/70 overflow-y-auto rounded-lg border border-zinc-800">
            <li v-for="model in visibleModels(target.provider)" :key="model.modelId" class="flex items-center gap-3 px-3 py-2 font-normal">
              <input type="checkbox" class="accent-emerald-500" :checked="target.models.includes(model.modelId)" @change="toggleModel(target, model.modelId)" />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-mono text-[13px]">{{ model.modelId }}</span>
                <span v-if="model.price" class="text-xs text-zinc-500">${{ model.price.input }} / ${{ model.price.output }} por 1M</span>
              </span>
              <span v-if="target.models[0] === model.modelId" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">padrão</span>
              <button v-else-if="target.models.includes(model.modelId)" type="button" class="text-xs text-zinc-400 hover:text-zinc-100" @click="makeDefault(target, model.modelId)">tornar padrão</button>
            </li>
          </ul>
        </div>
        <small v-if="anyCompatible" class="hint">Provider compatível: tool use e raciocínio variam por modelo.</small>
        <small v-if="form.providers.length > 1" class="hint">Ao trocar de provider no meio da conversa, o novo recebe a transcrição dos turnos (o estado interno do anterior não vai junto).</small>
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
            :disabled="!lanesAllowed.includes(mode)"
            @click="toggle(form.modes, mode)"
          >
            {{ mode === 'chat' ? 'Chat' : 'Agents SDK' }}
          </button>
        </div>
        <small v-if="anySubscription" class="hint">Assinatura: só a lane Agents SDK, e só quem administra conversa nela (a conta é pessoal).</small>
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

    </fieldset>
    <fieldset v-show="tab === 'ferramentas'" class="grid gap-4 sm:grid-cols-2">
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

      <div v-if="orphans.length" class="field sm:col-span-2">
        <span>Órfãs <em class="font-normal text-zinc-500">— escolhidas, mas que os providers do agente ou o servidor não oferecem; o servidor recusa o salvamento com elas</em></span>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="entry in orphans" :key="entry" type="button" class="chip on danger font-mono text-xs" title="Clique para tirar do agente" @click="toggle(form.allowedTools, entry)">
            <span class="mr-1 rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-200">órfão</span>{{ entry }} ✕
          </button>
        </div>
      </div>

    </fieldset>
    <fieldset v-show="tab === 'mcps'" class="grid gap-4 sm:grid-cols-2">
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
                v-for="tool in mcpChips(server.id)"
                :key="tool.name"
                type="button"
                class="chip font-mono text-xs"
                :class="{ on: form.allowedTools.includes(mcpRef(server.id, tool.name)) }"
                :title="tool.unlisted ? 'Escolhida, mas o servidor não a listou agora (fora do ar, ou só aparece dentro de uma conversa)' : tool.description"
                @click="toggle(form.allowedTools, mcpRef(server.id, tool.name))"
              >
                {{ tool.name }}<span v-if="tool.unlisted" class="ml-1 text-[10px] text-zinc-500">não listada</span>
              </button>
              <span v-if="!mcpChips(server.id).length" class="text-xs text-zinc-500">Nenhuma ferramenta listada agora.</span>
            </div>
          </div>
        </div>
        <span v-else class="text-sm font-normal text-zinc-500">Nenhum MCP ligado. <RouterLink to="/mcp" class="text-emerald-400 hover:underline">Cadastrar em MCPs</RouterLink>.</span>
      </div>

    </fieldset>
    <fieldset v-show="tab === 'sdk'" class="grid gap-4 sm:grid-cols-2">
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
              <span v-else-if="form.providers.length > 1" class="block text-xs text-zinc-500">roda em {{ nativeWhere(tool) }}</span>
            </span>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-[10px]" :class="RISK_CLASS[tool.risk]">{{ RISK_LABEL[tool.risk] }}</span>
          </li>
        </ul>
        <small v-if="dangerousNative" class="text-amber-300">⚠ Ferramentas que tocam este servidor dão ao agente acesso ao disco, à rede ou a comandos daqui. Só administradores conversam com ele.</small>
      </div>

    </fieldset>

    <p v-if="failure && !Object.keys(issues).length" class="text-sm whitespace-pre-line text-rose-300">{{ failure }}</p>
    <!-- O erro de campo aparece junto do campo, que pode estar fora da tela: aqui, perto do Salvar, o resumo. -->
    <p v-else-if="Object.keys(issues).length" class="text-sm text-rose-300">
      Não salvou — corrija: {{ summarizeIssues(issues, FIELD_LABEL) }}
    </p>
    <p v-if="agent?.updatedBy" class="text-xs text-zinc-500">Alterado por {{ agent.updatedBy }} em {{ agent.updatedAt ? new Date(agent.updatedAt).toLocaleString('pt-BR') : '' }}</p>

    <p v-if="loadError" class="text-sm text-rose-300">
      Não consegui carregar os providers ({{ loadError }}), então não dá para salvar.
      <button type="button" class="underline hover:text-rose-200" @click="loadBase">Tentar de novo</button>
    </p>
    <p v-else-if="!ready" class="text-xs text-zinc-500">Carregando providers…</p>

    <div class="flex gap-2">
      <button type="submit" :disabled="saving || !ready || !!loadError || !form.providers.length" class="rounded-full bg-emerald-500 px-5 py-2 font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{{ saving ? 'Salvando…' : creating ? 'Criar agente' : 'Salvar' }}</button>
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
