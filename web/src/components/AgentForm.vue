<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import { providerLabel } from '@/lib/format'
import { useProvidersStore } from '@/stores/providers'
import type { IAgentDetail, IAgentInput, ICatalogModel, TMode } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps<{ agent?: IAgentDetail; creating: boolean }>()
const emit = defineEmits<{ saved: [id: string]; duplicate: [agent: IAgentDetail]; removed: [] }>()

const agents = useAgentsStore()
const providers = useProvidersStore()

/** Os providers configurados e ligados; um desligado só aparece se for o deste agente. */
const providerOptions = computed(() => providers.list.filter((provider) => provider.enabled || provider.id === form.value.provider))
const protocol = computed(() => providers.list.find((provider) => provider.id === form.value.provider)?.protocol ?? form.value.provider)
const compatible = computed(() => !!providers.list.find((provider) => provider.id === form.value.provider)?.baseUrl)

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

const blank = (): IAgentInput => ({ id: '', name: '', provider: 'claude', systemPrompt: '', models: [], reasoningEfforts: [], modes: ['chat', 'agent'], allowedTools: [] })
const form = ref<IAgentInput>(blank())
/** Modelos que o agente declarava e que estão desligados no catálogo: saem ao salvar. */
const droppedModels = ref<string[]>([])
const effortsText = ref('')
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
    form.value = agent ? { id: agent.id, name: agent.name, provider: agent.provider, systemPrompt: agent.systemPrompt, models: [...agent.models], reasoningEfforts: [...(agent.reasoningEfforts ?? [])], modes: [...agent.modes], allowedTools: [...agent.allowedTools] } : blank()
    // Os desligados no catálogo não entram no formulário: salvar com eles seria recusado.
    droppedModels.value = agent?.disabledModels ?? []
    form.value.models = form.value.models.filter((model) => !droppedModels.value.includes(model))
    effortsText.value = (form.value.reasoningEfforts ?? []).join(', ')
    issues.value = {}
    failure.value = undefined
  },
  { immediate: true },
)

const list = (text: string) =>
  text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)

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
    const input: IAgentInput = { ...form.value, reasoningEfforts: list(effortsText.value) }
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
        <div class="flex gap-1.5">
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
        <div class="flex gap-1.5">
          <button v-for="mode in (['chat', 'agent'] as TMode[])" :key="mode" type="button" class="chip" :class="{ on: form.modes.includes(mode) }" @click="toggle(form.modes, mode)">{{ mode === 'chat' ? 'Chat' : 'Agents SDK' }}</button>
        </div>
        <small v-for="message in issues.modes" :key="message" class="error">{{ message }}</small>
      </div>
      <label class="field">
        <span>Níveis de raciocínio</span>
        <input v-model="effortsText" class="input font-mono" placeholder="low, medium, high" />
      </label>

      <div class="field sm:col-span-2">
        <span>Ferramentas <em class="font-normal text-zinc-500">{{ agents.mcpConnected ? '' : '(MCP desconectado: só as locais aparecem)' }}</em></span>
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

      <label class="field sm:col-span-2">
        <span>Instrução do sistema</span>
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
