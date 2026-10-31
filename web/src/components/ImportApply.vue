<script setup lang="ts">
import { computed, inject, onMounted, ref, shallowRef } from 'vue'
import { routerKey } from 'vue-router'
import DiffView from '@/components/DiffView.vue'
import WideningConfirm from '@/components/WideningConfirm.vue'
import {
  applyToCatalog,
  blocking,
  classifyApplyFailure,
  OP_LABEL,
  PHASE_LABEL,
  previewApply,
  type IApplyPreview,
  type IApplyResult,
  type IApplySelection,
} from '@/lib/importApply'
import { useAuthStore } from '@/stores/auth'

/**
 * GRAVAR NO CATÁLOGO (só admin): os aprovados do alvo (um lote salvo, a seleção, ou todo o trabalho) viram documentos
 * canônicos e a tela mostra o PLANO do catálogo sobre eles — o diff de cada item, as ampliações, as referências
 * quebradas, os segredos que faltam e a ordem. O agente nasce FECHADO: as regras amplas do tradutor ficam desmarcadas,
 * e só entram se a pessoa as marcar; o agente novo precisa de um modelo (os ativos no gateway).
 *
 * ⛔ Nada grava sem o clique em "Gravar no catálogo" e, havendo ampliação, sem TODAS as caixas marcadas (o
 * `WideningConfirm`, o mesmo do histórico). Sucesso: os itens viram `applied` e o lote abre no histórico.
 */
const props = defineProps<{
  projectId: string
  jobId: string
  target: { batchId?: string; keys?: string[]; label: string }
  readonly?: boolean
}>()
const emit = defineEmits<{ close: []; applied: [result: IApplyResult] }>()

const auth = useAuthStore()
/** Sem roteador (um teste da tela de fora), o link do lote é um link comum. */
const router = inject(routerKey, undefined)
const preview = shallowRef<IApplyPreview>()
const loading = ref(false)
const writing = ref(false)
const error = ref<string>()
const result = shallowRef<IApplyResult>()
/** As regras amplas incluídas, por agente; o modelo escolhido, por agente. */
const wide = ref<Record<string, string[]>>({})
const models = ref<Record<string, { provider: string; model: string }>>({})
/** A confirmação aberta (a lista do plano, ou a que o servidor devolveu). */
const confirming = ref(false)
const openDiff = ref<Set<string>>(new Set())

const selection = computed<IApplySelection>(() => ({
  ...(props.target.batchId ? { batchId: props.target.batchId } : {}),
  ...(props.target.keys ? { keys: props.target.keys } : {}),
  ...(Object.values(wide.value).some((keys) => keys.length) ? { wide: wide.value } : {}),
  ...(Object.keys(models.value).length ? { models: models.value } : {}),
}))

const plan = computed(() => preview.value?.plan)
const changing = computed(() => (plan.value?.items ?? []).filter((item) => item.op !== 'unchanged'))
const blockers = computed(() => (plan.value?.items ?? []).filter(blocking))
const canWrite = computed(() => auth.isAdmin && !props.readonly && !!plan.value && !blockers.value.length && plan.value.order.length > 0 && !writing.value)

async function load() {
  loading.value = true
  error.value = undefined
  try {
    preview.value = await previewApply(props.projectId, props.jobId, selection.value)
    for (const agent of preview.value.agents) if (agent.model && !models.value[agent.key]) models.value = { ...models.value, [agent.key]: agent.model }
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    loading.value = false
  }
}
onMounted(load)

function toggleWide(agentKey: string, ruleKey: string, on: boolean) {
  const current = new Set(wide.value[agentKey] ?? [])
  if (on) current.add(ruleKey)
  else current.delete(ruleKey)
  wide.value = { ...wide.value, [agentKey]: [...current] }
  void load()
}

function pickModel(agentKey: string, value: string) {
  const [provider, ...rest] = value.split('|')
  if (!provider || !rest.length) return
  models.value = { ...models.value, [agentKey]: { provider, model: rest.join('|') } }
  void load()
}
const modelValue = (agentKey: string) => (models.value[agentKey] ? `${models.value[agentKey].provider}|${models.value[agentKey].model}` : '')

function toggleDiff(ref: string) {
  const next = new Set(openDiff.value)
  if (next.has(ref)) next.delete(ref)
  else next.add(ref)
  openDiff.value = next
}

/** O clique: sem ampliação grava direto; com, abre as caixas (todas obrigatórias). */
function start() {
  if (!canWrite.value || !plan.value) return
  if (plan.value.widenings.length) confirming.value = true
  else void write([])
}

async function write(confirm: string[]) {
  if (!plan.value) return
  writing.value = true
  error.value = undefined
  try {
    result.value = await applyToCatalog(props.projectId, props.jobId, selection.value, plan.value.planHash, confirm)
    confirming.value = false
    emit('applied', result.value)
  } catch (failure) {
    const reason = classifyApplyFailure(failure)
    confirming.value = false
    if (reason.type === 'plan-changed') {
      error.value = 'O catálogo ou os rascunhos mudaram desde o plano. O plano foi refeito: revise e grave de novo.'
      await load()
    } else if (reason.type === 'widening') {
      error.value = 'As ampliações mudaram. O plano foi refeito: confirme de novo.'
      await load()
    } else error.value = reason.message
  } finally {
    writing.value = false
  }
}

const historyLink = computed(() => (result.value?.batch ? `/catalog/history?lote=${encodeURIComponent(result.value.batch.id)}` : undefined))
const partLabel = (part?: string) => (part === 'record' ? ' (registro)' : part === 'links' ? ' (vínculos)' : part === 'reach' ? ' (alcance)' : '')
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border border-emerald-500/30 p-3" data-test="import-apply">
    <header class="flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-semibold text-zinc-100">Gravar no catálogo: {{ target.label }}</h2>
      <span v-if="plan" class="text-xs text-zinc-500">escopo {{ plan.scope }}</span>
      <button type="button" class="btn btn-ghost btn-sm ml-auto" @click="emit('close')">Fechar</button>
    </header>
    <p class="text-xs text-zinc-500">
      Os itens aprovados viram documentos do catálogo, conferidos de novo contra a fonte. O agente nasce fechado: o alcance entra por último, e cada ampliação pede a sua caixa.
    </p>

    <p v-if="loading && !preview" class="text-sm text-zinc-500">Montando o plano…</p>
    <p v-if="error" class="text-sm text-rose-300" data-test="apply-error">{{ error }}</p>

    <template v-if="preview && plan && !result">
      <p class="text-xs text-zinc-400" data-test="apply-summary">
        {{ preview.items.length }} item(ns) aprovado(s) → {{ plan.summary.create ?? 0 }} a criar, {{ plan.summary.update ?? 0 }} a alterar, {{ plan.summary.unchanged ?? 0 }} sem mudança<template
          v-if="blockers.length"
        >
          · <span class="text-rose-300">{{ blockers.length }} bloqueando</span></template
        >
      </p>
      <ul v-if="preview.skipped.length" class="text-xs text-zinc-500" data-test="apply-skipped">
        <li v-for="entry in preview.skipped" :key="entry.key">fica de fora: <code>{{ entry.key }}</code> — {{ entry.reason }}</li>
      </ul>

      <section v-for="agent in preview.agents" :key="agent.key" class="flex flex-col gap-2 rounded-lg border border-zinc-800 p-2" data-test="apply-agent">
        <p class="text-sm text-zinc-200">
          Agente <code>{{ agent.id }}</code> <span class="text-xs text-zinc-500">{{ agent.exists ? 'já existe' : 'novo' }}</span>
        </p>
        <label class="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          Modelo
          <select class="input w-auto py-1 text-xs" :value="modelValue(agent.key)" data-test="apply-model" @change="pickModel(agent.key, ($event.target as HTMLSelectElement).value)">
            <option value="" disabled>escolha um modelo ativo</option>
            <optgroup v-for="group in preview.models" :key="group.provider" :label="group.provider">
              <option v-for="model in group.models" :key="model" :value="`${group.provider}|${model}`">{{ model }}</option>
            </optgroup>
          </select>
        </label>
        <div v-if="agent.rules.length" class="flex flex-col gap-1">
          <p class="text-xs text-zinc-400">Alcance traduzido. As regras amplas ficam de fora; marque só a que deve entrar:</p>
          <label v-for="rule in agent.rules" :key="rule.key" class="flex items-start gap-2 text-xs" :class="rule.wide ? 'text-amber-200' : 'text-zinc-300'">
            <input
              type="checkbox"
              class="mt-0.5 accent-amber-500"
              :checked="rule.included"
              :disabled="!rule.wide || loading"
              :data-rule="rule.key"
              data-test="apply-wide"
              @change="toggleWide(agent.key, rule.key, ($event.target as HTMLInputElement).checked)"
            />
            <span>
              <code>{{ rule.rule.category }} {{ rule.rule.decision }} {{ rule.rule.pattern }}</code>
              <template v-if="rule.wide"> — ampla: {{ rule.wide }}</template>
            </span>
          </label>
        </div>
        <p class="text-xs text-zinc-500">
          Ferramentas: {{ agent.allowedTools.join(', ') || 'nenhuma' }} · skills: {{ agent.skills.join(', ') || 'nenhuma' }}<template v-if="agent.pendingSkills.length">
            · pendentes (fora do catálogo): {{ agent.pendingSkills.join(', ') }}</template
          >
        </p>
        <ul v-if="agent.notes.length" class="list-disc pl-5 text-xs text-zinc-500">
          <li v-for="(note, index) in agent.notes" :key="index">{{ note }}</li>
        </ul>
      </section>

      <ul class="divide-y divide-zinc-800 rounded-lg border border-zinc-800 text-xs" data-test="apply-items">
        <li v-for="item in changing" :key="item.ref" class="flex flex-col gap-1 px-2 py-1.5">
          <span class="flex flex-wrap items-center gap-2">
            <code class="text-zinc-200">{{ item.ref }}</code>
            <span :class="blocking(item) ? 'text-rose-300' : 'text-zinc-400'">{{ OP_LABEL[item.op] }}</span>
            <span v-if="item.entersDisabled" class="text-amber-300">entra desligado (falta segredo)</span>
            <button v-if="item.diff" type="button" class="btn btn-ghost btn-sm ml-auto" @click="toggleDiff(item.ref)">{{ openDiff.has(item.ref) ? 'Esconder diff' : 'Ver diff' }}</button>
          </span>
          <ul v-if="item.issues.length" class="list-disc pl-5 text-rose-300">
            <li v-for="(issue, index) in item.issues" :key="index">{{ issue.field }}: {{ issue.message }}</li>
          </ul>
          <ul v-if="item.brokenRefs.length" class="list-disc pl-5 text-amber-200">
            <li v-for="(broken, index) in item.brokenRefs" :key="index">{{ broken.message }}</li>
          </ul>
          <DiffView v-if="item.diff && openDiff.has(item.ref)" :hunks="item.diff.hunks" />
        </li>
      </ul>

      <div v-if="plan.attentions.length" class="text-xs text-zinc-400">
        <p class="font-medium">Atenção</p>
        <ul class="list-disc pl-5">
          <li v-for="attention in plan.attentions" :key="attention.key">{{ attention.description }}</li>
        </ul>
      </div>
      <p v-if="plan.missingSecrets.length" class="text-xs text-amber-200" data-test="apply-secrets">
        Segredos faltando: <template v-for="entry in plan.missingSecrets" :key="entry.ref">{{ entry.ref }} ({{ entry.secrets.join(', ') }}) </template>— o MCP entra desligado.
      </p>
      <ol v-if="plan.order.length" class="list-decimal pl-5 text-xs text-zinc-500" data-test="apply-order">
        <li v-for="(step, index) in plan.order" :key="index">{{ PHASE_LABEL[step.phase] ?? step.phase }}: <code>{{ step.ref }}</code>{{ partLabel(step.part) }}</li>
      </ol>

      <WideningConfirm v-if="confirming" :widenings="plan.widenings" action="Gravar com estas ampliações" :busy="writing" @confirm="write" @cancel="confirming = false" />
      <div v-else class="flex flex-wrap items-center gap-2">
        <button v-if="auth.isAdmin" type="button" class="btn btn-primary" :disabled="!canWrite" data-test="apply-write" @click="start">
          {{ writing ? 'Gravando…' : 'Gravar no catálogo' }}
        </button>
        <span v-if="plan.widenings.length" class="text-xs text-amber-200">{{ plan.widenings.length }} ampliação(ões) a confirmar, uma a uma</span>
        <span v-if="!plan.order.length && !blockers.length" class="text-xs text-zinc-500">Nada a gravar: o catálogo já está assim.</span>
      </div>
    </template>

    <div v-if="result" class="flex flex-col gap-1 text-sm" data-test="apply-result">
      <p class="text-zinc-200">
        {{ result.items.applied.length }} item(ns) gravado(s)<template v-if="result.batch">
          no lote <code>{{ result.batch.id }}</code> ({{ result.batch.status === 'applied' ? 'aplicado' : 'parcial' }})</template
        >.
        <template v-if="historyLink">
          <RouterLink v-if="router" :to="historyLink" class="text-emerald-300 hover:underline" data-test="apply-history">Ver o lote no histórico</RouterLink>
          <a v-else :href="historyLink" class="text-emerald-300 hover:underline" data-test="apply-history">Ver o lote no histórico</a>
        </template>
      </p>
      <p v-if="result.failed" class="text-rose-300">
        Parou em <code>{{ result.failed.ref }}</code>{{ partLabel(result.failed.part) }}: {{ result.failed.message }}. {{ result.pending.length }} passo(s) não aplicado(s). Para desfazer o que entrou, use
        "Reverter lote" no histórico.
      </p>
      <p v-if="result.missingSecrets.length" class="text-amber-200">Cadastre os segredos na tela do MCP: {{ result.missingSecrets.map((item) => `${item.ref} (${item.secrets.join(', ')})`).join('; ') }}</p>
    </div>
  </section>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
