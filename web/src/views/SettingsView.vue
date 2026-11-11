<script setup lang="ts">
import SaveFooter from '@/components/SaveFooter.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import { lite } from '@/lib/edition'
import type { IProviderStatus, TAudience, TLimitName } from '@/lib/types'
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
const classifyTurns = ref(false)
/** `provider::modelo` do construtor de skills e commands — vazio = o do Atlas. Lane agent: assinatura serve. */
const builder = ref('')
const saved = ref<string>()
const failure = ref<string>()
/** Os problemas de um 422, campo a campo — mostrados junto do Salvar. */
const issues = ref<Array<{ field: string; message: string }>>([])
/** O grupo de modelos padrão, em edição (vazio = nenhum). Os grupos em si moram em `/model-groups`. */
const defaultGroup = ref('')
/** 🌿 Esta instalação no git (ver `Git.Guard` no servidor): vazio = o padrão. */
const git = ref({ installationName: '', branchPrefix: '', baseBranch: '', protectedBranches: '', lockMainCheckout: true })
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
  { name: 'compactAtPercent', label: 'Compactar o contexto em (% da janela)' },
  { name: 'loopRefuseAt', label: 'Laço: recusa a chamada repetida na vez' },
  { name: 'loopStopAt', label: 'Laço: para o turno na chamada repetida' },
  { name: 'loopMaxErrors', label: 'Laço: para o turno com erros seguidos' },
  { name: 'monthlyCostCapUsd', label: 'Teto do mês do gateway (US$)' },
  { name: 'userMonthlyCostCapUsd', label: 'Teto do mês por pessoa (US$)' },
  { name: 'monthlyTokenCap', label: 'Teto do mês do gateway (tokens)' },
  { name: 'userMonthlyTokenCap', label: 'Teto do mês por pessoa (tokens)' },
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
  void providers.ensure().catch(() => undefined)
  await settings.ensure().catch((error) => (failure.value = String(error)))
})

/** Os providers ligados que rodam (assinatura, ou com chave): os modelos deles vêm da store, lidos uma vez cada. */
const runnableProviders = computed(() => providers.list.filter((provider) => provider.enabled && (provider.subscription || provider.credential.configured)))
watch(
  () => runnableProviders.value.map((provider) => provider.id),
  (ids) => ids.forEach((id) => void providers.models(id).catch(() => undefined)),
  { immediate: true },
)
const enabledModels = (provider: IProviderStatus) =>
  (providers.catalogs.get(provider.id) ?? []).filter((model) => model.enabled).map((model) => ({ value: `${provider.id}::${model.modelId}`, provider: provider.id, model: model.modelId }))
/** Os modelos ativados de cada provider ligado e com chave de API — a lista do classificador (assinatura não classifica). */
const classifierOptions = computed(() => runnableProviders.value.filter((provider) => !provider.subscription).flatMap(enabledModels))
/** O construtor roda na lane agent: a assinatura serve. */
const builderOptions = computed(() => runnableProviders.value.flatMap(enabledModels))

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
    defaultGroup.value = current.defaultModelGroup ?? ''
    git.value = {
      installationName: current.installationName ?? '',
      branchPrefix: current.branchPrefix ?? '',
      baseBranch: current.baseBranch ?? '',
      protectedBranches: (current.protectedBranches ?? []).join(', '),
      lockMainCheckout: current.lockMainCheckout !== false,
    }
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
      // A sequência padrão vai junto (um salvar só por tela); "Nenhum" = `null` desliga a troca dos agentes sem sequência.
      defaultModelGroup: defaultGroup.value || null,
      installationName: git.value.installationName.trim() || null,
      branchPrefix: git.value.branchPrefix.trim() || null,
      baseBranch: git.value.baseBranch.trim() || null,
      protectedBranches: git.value.protectedBranches.split(/[\s,]+/).filter(Boolean).length ? git.value.protectedBranches.split(/[\s,]+/).filter(Boolean) : null,
      lockMainCheckout: git.value.lockMainCheckout,
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
  <div class="h-full overflow-y-auto px-4 py-6">
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
            <select v-model="agentId" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 h-9" @change="onAgentChange">
              <option value="">Padrão ({{ settings.current.defaults?.agentId ?? 'nenhum agente ativo' }})</option>
              <!-- Inativo aparece, mas não se escolhe: o servidor recusaria, e o motivo diz o que resolver. -->
              <option v-for="option in agents.conversable" :key="option.id" :value="option.id" :disabled="!!option.unavailable">{{ option.name }}{{ option.unavailable ? ` (${option.unavailable.label})` : '' }}</option>
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Modelo padrão
            <select v-model="model" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 h-9">
              <option value="">Padrão do agente</option>
              <optgroup v-for="provider in agent?.providers ?? []" :key="provider.id" :label="provider.name">
                <option v-for="option in provider.models" :key="option" :value="`${provider.id}|${option}`" :disabled="!!provider.unavailable">{{ option }}{{ provider.unavailable ? ` (${provider.unavailable.label})` : '' }}</option>
              </optgroup>
            </select>
          </label>
          <!-- A lite não tem o classificador nem o construtor. -->
          <template v-if="!lite">
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Modelo de classificação
            <select v-model="classifier" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 h-9 text-sm">
              <option value="">Nenhum (sem classificação)</option>
              <option v-if="classifier && !classifierOptions.some((option) => option.value === classifier)" :value="classifier">{{ classifier.replace('::', ' · ') }} (não ativado)</option>
              <option v-for="option in classifierOptions" :key="option.value" :value="option.value">{{ protocols.providerName(option.provider) }} · {{ option.model }}</option>
            </select>
            <small class="text-xs text-zinc-500">Só modelos ativados com chave (sem assinatura). Prefira um pequeno: roda a cada mensagem.</small>
          </label>
          <label class="flex items-center gap-2 self-start text-sm text-zinc-300 sm:mt-6 sm:h-[38px]">
            <input v-model="classifyTurns" type="checkbox" class="accent-emerald-500" /> Classificar cada mensagem
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300 sm:col-span-2">
            Modelo do construtor
            <select v-model="builder" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 h-9 text-sm">
              <option value="">Mesmo do Atlas</option>
              <option v-if="builder && !builderOptions.some((option) => option.value === builder)" :value="builder">{{ builder.replace('::', ' · ') }} (não ativado)</option>
              <option v-for="option in builderOptions" :key="option.value" :value="option.value">{{ protocols.providerName(option.provider) }} · {{ option.model }}</option>
            </select>
            <small class="text-xs text-zinc-500">Redige skills e commands na guia Construir. Prefira um modelo forte.</small>
          </label>
          </template>
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
                :step="settings.current.limitBounds[limit.name]?.cents ? '0.01' : '1'"
                :min="settings.current.limitBounds[limit.name]?.unlimited ? -1 : settings.current.limitBounds[limit.name]?.min"
                :max="settings.current.limitBounds[limit.name]?.max"
                :placeholder="settings.current.limitsInEffect?.[limit.name] === -1 ? 'sem teto' : String(settings.current.limitsInEffect?.[limit.name] ?? '')"
                class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm tabular-nums"
              />
              <small class="text-xs text-zinc-500"
                >{{ settings.current.limitBounds[limit.name]?.min }} a {{ settings.current.limitBounds[limit.name]?.max
                }}<template v-if="settings.current.limitBounds[limit.name]?.unlimited">, ou -1 para sem teto (o detector de laço e o botão parar seguram)</template></small
              >
            </label>
          </div>
        </div>

        <ul v-if="issues.length" class="list-disc pl-5 text-sm text-rose-300">
          <li v-for="(issue, index) in issues" :key="index"><code v-if="issue.field" class="text-xs text-rose-200">{{ issue.field }}</code><template v-if="issue.field">: </template>{{ issue.message }}</li>
        </ul>
        <p v-if="settings.current.updatedBy" class="text-xs text-zinc-500">Última alteração por {{ settings.current.updatedBy }} em {{ new Date(settings.current.updatedAt ?? '').toLocaleString('pt-BR') }}</p>
      </section>

      <section v-if="!lite && auth.isAdmin && settings.current" class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 class="font-medium">Troca automática de modelo</h2>
        <p class="text-xs text-zinc-400">
          A sequência dos agentes que não escolheram uma: a conversa começa no primeiro modelo disponível dela e, se o modelo falha (cota, limite de uso…), segue no próximo e fica nele.
        </p>
        <label class="flex max-w-xs flex-col gap-1 text-sm text-zinc-300">
          Sequência padrão
          <select v-model="defaultGroup" aria-label="Sequência padrão" class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-sm">
            <option value="">Nenhum</option>
            <option v-for="group in settings.current.modelGroups ?? []" :key="group.id" :value="group.id">{{ group.name }}</option>
          </select>
        </label>
        <RouterLink to="/model-groups" class="text-sm text-emerald-300 underline">Gerenciar as sequências</RouterLink>
        <p v-if="settings.current.benched?.length" class="text-xs text-amber-300">
          Sem cota agora:
          {{ settings.current.benched.map((item) => `${protocols.providerName(item.provider)} até ${new Date(item.until).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`).join(', ') }}
        </p>
      </section>

      <section v-if="!lite && auth.isAdmin && settings.current" class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5" data-test="installation-git">
        <h2 class="font-medium">Esta instalação no git</h2>
        <p class="text-xs text-zinc-400">
          A pasta principal de cada repositório fica na branch base: os agentes trabalham em worktrees, e o ambiente não recarrega por troca de branch. As branches
          protegidas só recebem por PR. O prefixo separa as branches deste gateway das de outro no mesmo remoto.
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm text-zinc-300">
            Nome da instalação
            <input v-model="git.installationName" maxlength="60" class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm" placeholder="gateway do Henrique" />
          </label>
          <label class="flex flex-col gap-1 text-sm text-zinc-300">
            Prefixo das branches
            <input v-model="git.branchPrefix" maxlength="40" class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 font-mono text-sm" placeholder="henrique/" />
          </label>
          <label class="flex flex-col gap-1 text-sm text-zinc-300">
            Branch base das worktrees
            <input v-model="git.baseBranch" maxlength="100" class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 font-mono text-sm" placeholder="automation" />
          </label>
          <label class="flex flex-col gap-1 text-sm text-zinc-300">
            Branches protegidas
            <input v-model="git.protectedBranches" class="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-3 font-mono text-sm" placeholder="automation, main" />
          </label>
        </div>
        <label class="flex items-center gap-2 text-sm text-zinc-300">
          <input v-model="git.lockMainCheckout" type="checkbox" class="accent-emerald-500" />
          Travar a troca de branch na pasta principal do repositório
        </label>
      </section>

      <section v-if="!lite && auth.isAdmin && settings.current?.deployment" class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
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
      <!-- Um salvar só: a operação do gateway e a troca automática de modelo padrão. -->
      <SaveFooter v-if="auth.isAdmin && settings.current" label="Salvar configurações" @save="saveSettings">
        <span v-if="saved" class="text-sm text-emerald-300">{{ saved }}</span>
        <span v-if="failure" class="text-sm text-rose-300">{{ failure }}</span>
      </SaveFooter>
    </div>
  </div>
</template>
