<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import type { ISettings, TAudience, TLimitName } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { useProtocolsStore } from '@/stores/protocols'

const auth = useAuthStore()
const agents = useAgentsStore()
const settings = useSettingsStore()
const providers = useProvidersStore()
const protocols = useProtocolsStore()

/** A configuração do SISTEMA (só admin). O que é da pessoa — conta, senha, tokens — mora em Perfil. */
const audience = ref<TAudience>('all')
const agentId = ref('')
const model = ref('')
/** `provider::modelo` — o classificador é um modelo ATIVADO de um provider, escolhido numa lista. */
const classifier = ref('')
const classifierOptions = ref<Array<{ value: string; provider: string; model: string }>>([])
const classifyTurns = ref(false)
/** `provider::modelo` do construtor de skills e commands — vazio = o do Atlas. Lane agent: assinatura serve. */
const builder = ref('')
const builderOptions = ref<Array<{ value: string; provider: string; model: string }>>([])
const saved = ref<string>()
const failure = ref<string>()
/** Os problemas de um 422, campo a campo — mostrados junto do Salvar. */
const issues = ref<Array<{ field: string; message: string }>>([])
/** Os limites em edição; vazio = volta ao padrão do `.env` (vai como `null`). */
const limitDrafts = ref<Partial<Record<TLimitName, number | ''>>>({})

const LIMITS: Array<{ name: TLimitName; label: string }> = [
  { name: 'maxToolTurns', label: 'Passos de ferramenta por mensagem' },
  { name: 'maxOutputTokens', label: 'Tamanho máximo da resposta (tokens)' },
  { name: 'delegationMaxDepth', label: 'Níveis de delegação entre agentes' },
  { name: 'bashTimeoutMs', label: 'Tempo limite do terminal (ms)' },
  { name: 'bashMaxOutputChars', label: 'Saída máxima do terminal (caracteres)' },
  { name: 'sessionsPerOwner', label: 'Conversas simultâneas por pessoa' },
  { name: 'streamsPerOwner', label: 'Respostas simultâneas por pessoa' },
]

const DEPLOYMENT: Array<{ key: 'localToolsEnabled' | 'allowAnonymous'; label: string }> = [
  { key: 'allowAnonymous', label: 'Permite uso sem login' },
  { key: 'localToolsEnabled', label: 'Ferramentas locais no servidor' },
]

/** Booleano vira sim/não; texto (lista do `.env`) aparece como veio; ausente é "—". */
function deploymentValue(value: boolean | string | undefined): string {
  if (typeof value === 'boolean') return value ? 'sim' : 'não'
  return value || '—'
}

const AUDIENCE: Array<{ value: TAudience; label: string; hint: string }> = [
  { value: 'all', label: 'Aberto', hint: 'Qualquer pessoa com acesso abre conversa.' },
  { value: 'restricted', label: 'Restrito', hint: 'Só os papéis permitidos, com login.' },
  { value: 'off', label: 'Desligado', hint: 'Ninguém abre conversa nova. As em andamento terminam a mensagem atual.' },
]

const agent = computed(() => agents.byId.get(agentId.value || settings.current?.defaults?.agentId || ''))

onMounted(async () => {
  if (!auth.isAdmin) return
  await settings.load().catch((error) => (failure.value = String(error)))
  await loadClassifierOptions()
})

/** Os modelos ativados de cada provider ligado e com chave de API — a lista do classificador (assinatura não classifica). */
async function loadClassifierOptions() {
  await providers.load().catch(() => undefined)
  const lists = await Promise.all(
    providers.list
      .filter((provider) => provider.enabled && !provider.subscription && provider.credential.configured)
      .map(async (provider) => (await providers.models(provider.id).catch(() => [])).filter((model) => model.enabled).map((model) => ({ value: `${provider.id}::${model.modelId}`, provider: provider.id, model: model.modelId }))),
  )
  classifierOptions.value = lists.flat()
  const runnable = await Promise.all(
    providers.list
      .filter((provider) => provider.enabled && (provider.subscription || provider.credential.configured))
      .map(async (provider) => (await providers.models(provider.id).catch(() => [])).filter((model) => model.enabled).map((model) => ({ value: `${provider.id}::${model.modelId}`, provider: provider.id, model: model.modelId }))),
  )
  builderOptions.value = runnable.flat()
}

watch(
  () => settings.current,
  (current) => {
    if (!current) return
    audience.value = current.audience
    agentId.value = current.agentId ?? ''
    // Provider e modelo num valor só (`provider|modelo`); gravado antes do provider, só o modelo — no primeiro provider que o oferece.
    model.value = current.model ? `${current.provider ?? providerOfModel(current.model)}|${current.model}` : ''
    classifier.value = current.classifierModel ? `${current.classifierProvider ?? ''}::${current.classifierModel}` : ''
    classifyTurns.value = current.classifyTurns ?? false
    builder.value = current.builderModel ? `${current.builderProvider ?? ''}::${current.builderModel}` : ''
    limitDrafts.value = Object.fromEntries(LIMITS.map(({ name }) => [name, current.limits?.[name] ?? ''])) as Partial<Record<TLimitName, number | ''>>
  },
  { immediate: true },
)

/** O provider do agente escolhido que oferece este modelo (configuração gravada antes de haver provider). */
function providerOfModel(id: string): string {
  return agent.value?.providers.find((provider) => provider.models.includes(id))?.id ?? ''
}

/** ⚠️ O modelo é do agente: trocar o agente larga o modelo (volta a "Padrão do agente") em vez de mandar um que ele não tem. */
function onAgentChange() {
  model.value = ''
}

async function saveSettings() {
  saved.value = undefined
  failure.value = undefined
  issues.value = []
  try {
    // Vazio vira `null`: volta ao padrão em vez de gravar texto em branco.
    const [classifierProvider, classifierModel] = classifier.value ? classifier.value.split('::') : ['', '']
    const [builderProvider, builderModel] = builder.value ? builder.value.split('::') : ['', '']
    await settings.save({
      audience: audience.value,
      agentId: agentId.value || null,
      provider: model.value ? model.value.slice(0, model.value.indexOf('|')) : null,
      model: model.value ? model.value.slice(model.value.indexOf('|') + 1) : null,
      classifierModel: classifierModel || null,
      classifierProvider: classifierProvider || null,
      classifyTurns: classifyTurns.value,
      builderProvider: builderProvider || null,
      builderModel: builderModel || null,
      // Vazio = `null`: o limite volta ao padrão do `.env`.
      limits: Object.fromEntries(LIMITS.map(({ name }) => [name, limitDrafts.value[name] === '' || limitDrafts.value[name] === undefined ? null : Number(limitDrafts.value[name])])),
    })
    saved.value = 'Configuração salva. Vale para as próximas conversas.'
  } catch (error) {
    if (error instanceof ApiError && Array.isArray(error.details) && error.details.length) {
      issues.value = (error.details as Array<{ field?: string; message?: string }>).map((item) => ({ field: item.field ?? '', message: item.message ?? 'inválido' }))
      failure.value = 'Não salvou: corrija o que está abaixo.'
    } else failure.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <div class="scroll-thin h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 class="text-xl font-semibold">Configuração</h1>

      <section v-if="auth.isAdmin && settings.current" class="flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 class="font-medium">Operação do gateway</h2>

        <div class="flex flex-col gap-2">
          <span class="text-sm text-zinc-300">Quem pode abrir conversa</span>
          <label v-for="option in AUDIENCE" :key="option.value" class="flex cursor-pointer items-start gap-3 rounded-xl border p-3" :class="audience === option.value ? (option.value === 'off' ? 'border-rose-500/50 bg-rose-500/10' : 'border-emerald-500/50 bg-emerald-500/10') : 'border-zinc-800'">
            <input v-model="audience" type="radio" :value="option.value" class="mt-1 accent-emerald-500" />
            <span>
              <span class="block text-sm font-medium">{{ option.label }}</span>
              <span class="block text-xs text-zinc-400">{{ option.hint }}</span>
            </span>
          </label>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Agente padrão
            <select v-model="agentId" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2" @change="onAgentChange">
              <option value="">Padrão ({{ settings.current.defaults?.agentId ?? 'nenhum agente ativo' }})</option>
              <!-- Inativo aparece, mas não se escolhe: o servidor recusaria, e o motivo diz o que resolver. -->
              <option v-for="option in agents.conversable" :key="option.id" :value="option.id" :disabled="!!option.unavailable">{{ option.name }}{{ option.unavailable ? ` (${option.unavailable.label})` : '' }}</option>
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Modelo padrão
            <select v-model="model" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2">
              <option value="">Padrão do agente</option>
              <optgroup v-for="provider in agent?.providers ?? []" :key="provider.id" :label="provider.name">
                <option v-for="option in provider.models" :key="option" :value="`${provider.id}|${option}`" :disabled="!!provider.unavailable">{{ option }}{{ provider.unavailable ? ` (${provider.unavailable.label})` : '' }}</option>
              </optgroup>
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Modelo de classificação
            <select v-model="classifier" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2 text-sm">
              <option value="">Nenhum (sem classificação)</option>
              <option v-if="classifier && !classifierOptions.some((option) => option.value === classifier)" :value="classifier">{{ classifier.replace('::', ' · ') }} (não ativado)</option>
              <option v-for="option in classifierOptions" :key="option.value" :value="option.value">{{ protocols.providerName(option.provider) }} · {{ option.model }}</option>
            </select>
            <small class="text-xs text-zinc-500">Só modelos ativados com chave (sem assinatura). Prefira um pequeno: roda a cada mensagem.</small>
          </label>
          <label class="flex items-center gap-2 self-start text-sm text-zinc-300 sm:mt-6 sm:h-[38px]">
            <input v-model="classifyTurns" type="checkbox" class="accent-emerald-500" /> Classificar cada mensagem
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Modelo do construtor
            <select v-model="builder" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2 text-sm">
              <option value="">Mesmo do Atlas</option>
              <option v-if="builder && !builderOptions.some((option) => option.value === builder)" :value="builder">{{ builder.replace('::', ' · ') }} (não ativado)</option>
              <option v-for="option in builderOptions" :key="option.value" :value="option.value">{{ protocols.providerName(option.provider) }} · {{ option.model }}</option>
            </select>
            <small class="text-xs text-zinc-500">Redige skills e commands na guia Construir. Prefira um modelo forte.</small>
          </label>
        </div>

        <div v-if="settings.current.limitBounds" class="flex flex-col gap-2">
          <h3 class="text-sm font-medium text-zinc-300">Limites</h3>
          <p class="text-xs text-zinc-400">Em branco, vale o padrão (número cinza).</p>
          <div class="grid gap-3 sm:grid-cols-2">
            <label v-for="limit in LIMITS" :key="limit.name" class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
              {{ limit.label }}
              <input
                v-model="limitDrafts[limit.name]"
                type="number"
                step="1"
                :min="settings.current.limitBounds[limit.name]?.min"
                :max="settings.current.limitBounds[limit.name]?.max"
                :placeholder="String(settings.current.limitsInEffect?.[limit.name] ?? '')"
                class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm tabular-nums"
              />
              <small class="text-xs text-zinc-500">{{ settings.current.limitBounds[limit.name]?.min }} a {{ settings.current.limitBounds[limit.name]?.max }}</small>
            </label>
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button class="rounded-full bg-emerald-500 px-5 py-2 font-medium text-zinc-950 hover:bg-emerald-400" @click="saveSettings">Salvar</button>
          <span v-if="saved" class="text-sm text-emerald-300">{{ saved }}</span>
          <span v-if="failure" class="text-sm text-rose-300">{{ failure }}</span>
        </div>
        <ul v-if="issues.length" class="list-disc pl-5 text-sm text-rose-300">
          <li v-for="(issue, index) in issues" :key="index"><code v-if="issue.field" class="text-xs text-rose-200">{{ issue.field }}</code><template v-if="issue.field">: </template>{{ issue.message }}</li>
        </ul>
        <p v-if="settings.current.updatedBy" class="text-xs text-zinc-500">Última alteração por {{ settings.current.updatedBy }} em {{ new Date(settings.current.updatedAt ?? '').toLocaleString('pt-BR') }}</p>
      </section>

      <section v-if="auth.isAdmin && settings.current?.deployment" class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 class="font-medium">Implantação</h2>
        <p class="text-xs text-zinc-400">Só leitura. Para mudar, edite o <code>.env</code> do servidor e reinicie.</p>
        <dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <div v-for="item in DEPLOYMENT" :key="item.key" class="flex min-w-0 items-baseline justify-between gap-3 border-b border-zinc-800/70 pb-1.5">
            <dt class="text-zinc-400">{{ item.label }}</dt>
            <dd class="min-w-0 truncate font-mono text-xs text-zinc-200" :title="deploymentValue(settings.current.deployment[item.key])">{{ deploymentValue(settings.current.deployment[item.key]) }}</dd>
          </div>
        </dl>
        <p v-if="settings.current.deployment.sandbox" class="text-xs" :class="settings.current.deployment.sandbox.available ? 'text-emerald-300' : 'text-amber-300'">
          Isolamento dos agentes de projeto:
          {{ settings.current.deployment.sandbox.available ? 'ativo' : `indisponível — ${settings.current.deployment.sandbox.reason ?? 'sem motivo'}. O terminal deles fica bloqueado.` }}
        </p>
      </section>

      <p v-if="!auth.isAdmin" class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
        A configuração do sistema é só de quem administra.
        <RouterLink v-if="auth.user" to="/profile" class="text-emerald-300 underline">Ver meu perfil</RouterLink>
        <RouterLink v-else-if="auth.localAccounts" :to="{ path: '/login', query: { next: '/settings' } }" class="text-emerald-300 underline">Entrar</RouterLink>
      </p>
    </div>
  </div>
</template>
