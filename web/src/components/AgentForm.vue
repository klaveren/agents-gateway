<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import { PROVIDER_LABEL } from '@/lib/format'
import type { IAgentDetail, IAgentInput, TMode, TProvider } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'

const props = defineProps<{ agent?: IAgentDetail; creating: boolean }>()
const emit = defineEmits<{ saved: [id: string]; duplicate: [agent: IAgentDetail]; removed: [] }>()

const agents = useAgentsStore()

/** Sugestões por provider — os modelos que os embutidos já declaram. Digitar outro também vale. */
const suggestions = computed(() => {
  const byProvider: Record<string, Set<string>> = { claude: new Set(), openai: new Set(), google: new Set() }
  for (const agent of agents.list) for (const model of agent.models) byProvider[agent.provider]?.add(model)
  return byProvider
})

/** Ferramentas que mudam algo fora da conversa: o formulário avisa antes de dar ao agente. */
const DANGEROUS = new Set(['run_bash'])

const blank = (): IAgentInput => ({ id: '', name: '', provider: 'claude', systemPrompt: '', models: [], reasoningEfforts: [], modes: ['chat', 'agent'], allowedTools: [] })
const form = ref<IAgentInput>(blank())
const modelsText = ref('')
const effortsText = ref('')
const issues = ref<Record<string, string[]>>({})
const failure = ref<string>()
const saving = ref(false)

const readOnly = computed(() => !!props.agent?.builtIn && !props.creating)

watch(
  () => [props.agent, props.creating] as const,
  ([agent]) => {
    form.value = agent ? { id: agent.id, name: agent.name, provider: agent.provider, systemPrompt: agent.systemPrompt, models: [...agent.models], reasoningEfforts: [...(agent.reasoningEfforts ?? [])], modes: [...agent.modes], allowedTools: [...agent.allowedTools] } : blank()
    modelsText.value = form.value.models.join(', ')
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

function addModel(model: string) {
  const models = list(modelsText.value)
  if (!models.includes(model)) modelsText.value = [...models, model].join(', ')
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
    const input: IAgentInput = { ...form.value, models: list(modelsText.value), reasoningEfforts: list(effortsText.value) }
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
  if (!props.agent || !confirm(`Apagar o agente "${props.agent.name}"? As conversas gravadas com ele continuam.`)) return
  await agents.remove(props.agent.id)
  emit('removed')
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
          <button v-for="provider in (['claude', 'openai', 'google'] as TProvider[])" :key="provider" type="button" class="chip" :class="{ on: form.provider === provider }" @click="form.provider = provider">{{ PROVIDER_LABEL[provider] }}</button>
        </div>
      </div>

      <label class="field sm:col-span-2">
        <span>Modelos <em class="font-normal text-zinc-500">(o primeiro é o padrão)</em></span>
        <input v-model="modelsText" class="input font-mono" placeholder="claude-sonnet-5, claude-opus-5" />
        <div class="flex flex-wrap gap-1">
          <button v-for="model in suggestions[form.provider]" :key="model" type="button" class="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700" @click="addModel(model)">+ {{ model }}</button>
        </div>
        <small v-for="message in issues.models" :key="message" class="error">{{ message }}</small>
      </label>

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
        <small v-if="form.provider === 'google'" class="hint">Gemini (ADK): não use {chaves} — o ADK as lê como variável de sessão.</small>
        <small v-for="message in issues.systemPrompt" :key="message" class="error">{{ message }}</small>
      </label>
    </fieldset>

    <p v-if="failure && !Object.keys(issues).length" class="text-sm text-rose-300">{{ failure }}</p>
    <p v-if="agent?.updatedBy" class="text-xs text-zinc-500">Alterado por {{ agent.updatedBy }} em {{ agent.updatedAt ? new Date(agent.updatedAt).toLocaleString('pt-BR') : '' }}</p>

    <div v-if="!readOnly" class="flex gap-2">
      <button type="submit" :disabled="saving" class="rounded-full bg-emerald-500 px-5 py-2 font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{{ saving ? 'Salvando…' : creating ? 'Criar agente' : 'Salvar' }}</button>
      <button v-if="!creating && agent" type="button" class="rounded-full bg-zinc-800 px-4 py-2 hover:bg-zinc-700" @click="emit('duplicate', agent)">Duplicar</button>
      <button v-if="!creating && agent" type="button" class="ml-auto rounded-full px-4 py-2 text-rose-300 hover:bg-rose-500/10" @click="remove">Apagar</button>
    </div>
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
