<script setup lang="ts">
import { levelsFor, REASONING_LEVELS } from '@/lib/reasoning'
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import { providerLabel } from '@/lib/format'
import { useProvidersStore } from '@/stores/providers'
import type { IAgentDetail, IAgentInput, ICatalogModel, TMode } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useMcpStore } from '@/stores/mcp'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps<{ agent?: IAgentDetail; creating: boolean }>()
const emit = defineEmits<{ saved: [id: string]; duplicate: [agent: IAgentDetail]; removed: [] }>()

const agents = useAgentsStore()
const providers = useProvidersStore()
const mcp = useMcpStore()

/**
 * Os MCPs: por servidor ligado, "todas as ferramentas" (`mcp:<id>/*`) ou uma a uma (`mcp:<id>/<tool>`).
 * As ferramentas de cada servidor são lidas ao abrir o formulário.
 */
onMounted(async () => {
  await mcp.load().catch(() => undefined)
  await Promise.all(mcp.list.filter((server) => server.enabled).map((server) => mcp.loadTools(server.id).catch(() => [])))
})
const mcpRef = (server: string, tool: string) => `mcp:${server}/${tool}`
const enabledMcp = computed(() => mcp.list.filter((server) => server.enabled))
/** O que o agente escolheu e já não aparece acima (servidor desligado, removido, ou ferramenta que sumiu). */
const orphanMcp = computed(() =>
  form.value.allowedTools.filter((entry) => {
    if (!entry.startsWith('mcp:')) return false
    const [server, tool] = entry.slice(4).split('/')
    if (!enabledMcp.value.some((candidate) => candidate.id === server)) return true
    return tool !== '*' && !(mcp.tools[server] ?? []).some((candidate) => candidate.name === tool)
  }),
)
function toggleAllMcp(server: string) {
  const all = mcpRef(server, '*')
  if (form.value.allowedTools.includes(all)) form.value.allowedTools = form.value.allowedTools.filter((entry) => entry !== all)
  // "Todas" substitui as escolhidas uma a uma do mesmo servidor.
  else form.value.allowedTools = [...form.value.allowedTools.filter((entry) => !entry.startsWith(`mcp:${server}/`)), all]
}

/** Os providers configurados e ligados; um desligado só aparece se for o deste agente. */
const providerOptions = computed(() => providers.list.filter((provider) => provider.enabled || provider.id === form.value.provider))
const protocol = computed(() => providers.list.find((provider) => provider.id === form.value.provider)?.protocol ?? form.value.provider)
const compatible = computed(() => !!providers.list.find((provider) => provider.id === form.value.provider)?.baseUrl)

/** As ferramentas nativas do SDK deste provider (pelo protocolo), na ordem do risco. */
const RISK_ORDER = ['hosted', 'session', 'server-network', 'server-read', 'server-exec']
/** Os níveis que o protocolo deste provider aceita (Google: nenhum). */
const reasoningLevels = computed(() => REASONING_LEVELS[protocol.value] ?? [])

const natives = computed(() => agents.nativeTools.filter((tool) => tool.protocol === protocol.value).sort((a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk)))
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

/** Ferramentas que mudam algo fora da conversa: o formulário avisa antes de dar ao agente. */
const DANGEROUS = new Set(['run_bash'])

const blank = (): IAgentInput => ({ id: '', name: '', provider: 'claude', soul: '', systemPrompt: '', models: [], reasoningEfforts: [], modes: ['chat', 'agent'], allowedTools: [] })
const form = ref<IAgentInput>(blank())
/** Modelos que o agente declarava e que estão desligados no catálogo: saem ao salvar. */
const droppedModels = ref<string[]>([])
const issues = ref<Record<string, string[]>>({})
const failure = ref<string>()
const saving = ref(false)
const confirming = ref(false)
const deleting = ref(false)

watch(
  () => form.value.provider,
  async (provider) => {
    if (!provider) return
    loadingModels.value = true
    try {
      enabledModels.value = (await providers.models(provider)).filter((model) => model.enabled)
    } catch {
      enabledModels.value = []
    } finally {
      loadingModels.value = false
    }
  },
  { immediate: true },
)

const readOnly = computed(() => !!props.agent?.builtIn && !props.creating)

watch(
  () => [props.agent, props.creating] as const,
  ([agent]) => {
    form.value = agent ? { id: agent.id, name: agent.name, provider: agent.provider, soul: agent.soul ?? '', systemPrompt: agent.systemPrompt, models: [...agent.models], reasoningEfforts: [...(agent.reasoningEfforts ?? [])], modes: [...agent.modes], allowedTools: [...agent.allowedTools] } : blank()
    // Os desligados no catálogo não entram no formulário: salvar com eles seria recusado.
    droppedModels.value = agent?.disabledModels ?? []
    form.value.models = form.value.models.filter((model) => !droppedModels.value.includes(model))
    issues.value = {}
    failure.value = undefined
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

async function save() {
  saving.value = true
  issues.value = {}
  failure.value = undefined
  try {
    const input: IAgentInput = { ...form.value, reasoningEfforts: levelsFor(protocol.value, form.value.reasoningEfforts ?? []) }
    const saved = await agents.save(input, props.creating)
    emit('saved', saved.id)
  } catch (error) {
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
    failure.value = error instanceof Error ? error.message : String(error)
    confirming.value = false
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <form class="mx-auto flex max-w-3xl flex-col gap-5" @submit.prevent="save">
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
          <button v-for="provider in providerOptions" :key="provider.id" type="button" class="chip" :class="{ on: form.provider === provider.id }" @click="form.provider = provider.id">
            {{ provider.name }}<span v-if="!provider.enabled" class="text-[10px] text-zinc-500"> desligado</span>
          </button>
          <span v-if="!providerOptions.length" class="text-sm text-zinc-500">{{ providerLabel(form.provider) }}</span>
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
          <button v-for="mode in (['chat', 'agent'] as TMode[])" :key="mode" type="button" class="chip" :class="{ on: form.modes.includes(mode) }" @click="toggle(form.modes, mode)">{{ mode === 'chat' ? 'Chat' : 'Agents SDK' }}</button>
        </div>
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
            :class="{ on: form.allowedTools.includes(tool.name), danger: DANGEROUS.has(tool.name) }"
            :title="tool.description"
            @click="toggle(form.allowedTools, tool.name)"
          >
            {{ tool.name }} <span class="text-[10px] text-zinc-500">{{ tool.origin }}</span>
          </button>
          <span v-if="!agents.tools.length" class="text-sm text-zinc-500">Nenhuma disponível.</span>
        </div>
        <small v-if="form.allowedTools.some((tool) => DANGEROUS.has(tool))" class="text-amber-300">⚠ run_bash executa comandos no servidor do gateway. Quem conversa com este agente ganha esse poder.</small>
        <small v-for="message in issues.allowedTools" :key="message" class="error">{{ message }}</small>
      </div>

      <div class="field sm:col-span-2">
        <span>Pode delegar a <em class="font-normal text-zinc-500">— outros agentes a quem este pede parte do trabalho (rodam com as permissões de quem conversa; até 2 níveis, sem ciclos)</em></span>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="other in agents.list.filter((candidate) => candidate.id !== form.id)"
            :key="other.id"
            type="button"
            class="chip"
            :class="{ on: form.allowedTools.includes(`agent:${other.id}`) }"
            @click="toggle(form.allowedTools, `agent:${other.id}`)"
          >
            {{ other.name }}
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
        <div v-if="orphanMcp.length" class="flex flex-wrap items-center gap-1.5 text-xs font-normal">
          <span class="text-amber-300">Escolhidas, mas indisponíveis agora:</span>
          <button v-for="entry in orphanMcp" :key="entry" type="button" class="chip on font-mono text-xs" title="Clique para tirar do agente" @click="toggle(form.allowedTools, entry)">{{ entry }} ✕</button>
        </div>
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
        <small v-if="form.allowedTools.some((id) => natives.find((tool) => tool.id === id && tool.risk.startsWith('server')))" class="text-amber-300">⚠ Ferramentas que tocam este servidor dão ao agente acesso ao disco, à rede ou a comandos daqui — sem as travas do run_bash.</small>
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

    <p v-if="failure && !Object.keys(issues).length" class="text-sm text-rose-300">{{ failure }}</p>
    <p v-if="agent?.updatedBy" class="text-xs text-zinc-500">Alterado por {{ agent.updatedBy }} em {{ agent.updatedAt ? new Date(agent.updatedAt).toLocaleString('pt-BR') : '' }}</p>

    <div v-if="!readOnly" class="flex gap-2">
      <button type="submit" :disabled="saving" class="rounded-full bg-emerald-500 px-5 py-2 font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{{ saving ? 'Salvando…' : creating ? 'Criar agente' : 'Salvar' }}</button>
      <button v-if="!creating && agent" type="button" class="rounded-full bg-zinc-800 px-4 py-2 hover:bg-zinc-700" @click="emit('duplicate', agent)">Duplicar</button>
      <button v-if="!creating && agent" type="button" class="ml-auto rounded-full px-4 py-2 text-rose-300 hover:bg-rose-500/10" @click="confirming = true">Apagar</button>
    </div>
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
</style>
