<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AccessTokens from '@/components/AccessTokens.vue'
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
const route = useRoute()

/**
 * `/settings#conta` (o "Perfil" do menu da conta) leva direto ao cartão da conta. ⚠️ Tenta por um
 * instante: os cartões de cima aparecem quando as configurações chegam, e rolar antes erra o lugar.
 */
function scrollToSection(id: string, tries = 10) {
  const target = document.getElementById(id)
  if (target && settings.current) return target.scrollIntoView({ block: 'start' })
  if (tries > 0) setTimeout(() => scrollToSection(id, tries - 1), 100)
  else target?.scrollIntoView({ block: 'start' })
}

watch(
  () => route.hash,
  (hash) => {
    if (hash) void nextTick(() => scrollToSection(hash.slice(1)))
  },
  { immediate: true },
)


const currentPassword = ref('')
const nextPassword = ref('')
const passwordNote = ref<string>()
const passwordError = ref<string>()

const audience = ref<TAudience>('all')
const agentId = ref('')
const model = ref('')
/** `provider::modelo` — o classificador é um modelo ATIVADO de um provider, escolhido numa lista. */
const classifier = ref('')
const classifierOptions = ref<Array<{ value: string; provider: string; model: string }>>([])
const classifyTurns = ref(false)
const saved = ref<string>()
const failure = ref<string>()
/** Os problemas de um 422, campo a campo — mostrados junto do Salvar. */
const issues = ref<Array<{ field: string; message: string }>>([])
/** Os limites em edição; vazio = volta ao padrão do `.env` (vai como `null`). */
const limitDrafts = ref<Partial<Record<TLimitName, number | ''>>>({})

const LIMITS: Array<{ name: TLimitName; label: string }> = [
  { name: 'maxToolTurns', label: 'Voltas de ferramenta por turno' },
  { name: 'maxOutputTokens', label: 'Tokens de saída por resposta' },
  { name: 'delegationMaxDepth', label: 'Profundidade de delegação' },
  { name: 'bashTimeoutMs', label: 'Tempo limite do bash (ms)' },
  { name: 'bashMaxOutputChars', label: 'Saída máxima do bash (caracteres)' },
  { name: 'sessionsPerOwner', label: 'Sessões simultâneas por dono' },
  { name: 'streamsPerOwner', label: 'Streams simultâneos por dono' },
]

const DEPLOYMENT: Array<{ key: keyof NonNullable<ISettings['deployment']>; label: string }> = [
  { key: 'dangerousToolsAdminOnly', label: 'Ferramentas perigosas só para admin' },
  { key: 'subscriptionAdminOnly', label: 'Assinaturas só para admin' },
  { key: 'allowAnonymous', label: 'Aceita chamador anônimo' },
  { key: 'localToolsEnabled', label: 'Ferramentas locais' },
  { key: 'nativeToolsEnabled', label: 'Ferramentas nativas' },
]

/** Booleano vira sim/não; texto (lista do `.env`) aparece como veio; ausente é "—". */
function deploymentValue(value: boolean | string | undefined): string {
  if (typeof value === 'boolean') return value ? 'sim' : 'não'
  return value || '—'
}

const AUDIENCE: Array<{ value: TAudience; label: string; hint: string }> = [
  { value: 'all', label: 'Aberto', hint: 'Todo chamador que o gateway deixa passar abre sessão.' },
  { value: 'restricted', label: 'Restrito', hint: 'Só papéis de AUDIENCE_ROLES, com identidade provada.' },
  { value: 'off', label: 'Desligado', hint: 'Ninguém abre sessão nova. Conversas em andamento terminam o turno.' },
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

async function changePassword() {
  passwordNote.value = undefined
  passwordError.value = undefined
  try {
    await auth.changePassword(currentPassword.value, nextPassword.value)
    currentPassword.value = ''
    nextPassword.value = ''
    passwordNote.value = 'Senha trocada. As outras sessões desta conta foram encerradas.'
  } catch (error) {
    const issues = error instanceof ApiError ? error.fieldIssues : {}
    passwordError.value = issues.current ? 'A senha atual não confere.' : issues.password ? 'A nova senha precisa ter pelo menos 10 caracteres.' : String(error)
  }
}

async function saveSettings() {
  saved.value = undefined
  failure.value = undefined
  issues.value = []
  try {
    // Vazio vira `null`: volta ao padrão em vez de gravar texto em branco.
    const [classifierProvider, classifierModel] = classifier.value ? classifier.value.split('::') : ['', '']
    await settings.save({
      audience: audience.value,
      agentId: agentId.value || null,
      provider: model.value ? model.value.slice(0, model.value.indexOf('|')) : null,
      model: model.value ? model.value.slice(model.value.indexOf('|') + 1) : null,
      classifierModel: classifierModel || null,
      classifierProvider: classifierProvider || null,
      classifyTurns: classifyTurns.value,
      // Vazio = `null`: o limite volta ao padrão do `.env`.
      limits: Object.fromEntries(LIMITS.map(({ name }) => [name, limitDrafts.value[name] === '' || limitDrafts.value[name] === undefined ? null : Number(limitDrafts.value[name])])),
    })
    saved.value = 'Configuração salva — vale para a próxima sessão.'
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
            Modelo do classificador
            <select v-model="classifier" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2 text-sm">
              <option value="">Nenhum (sem classificação)</option>
              <option v-if="classifier && !classifierOptions.some((option) => option.value === classifier)" :value="classifier">{{ classifier.replace('::', ' · ') }} (não ativado)</option>
              <option v-for="option in classifierOptions" :key="option.value" :value="option.value">{{ protocols.providerName(option.provider) }} · {{ option.model }}</option>
            </select>
            <small class="text-xs text-zinc-500">Os modelos ativados em Providers (com chave, não assinatura). Sem escolha, nada é classificado. Prefira um pequeno: ele roda a cada turno.</small>
          </label>
          <label class="flex items-center gap-2 self-end pb-2 text-sm text-zinc-300">
            <input v-model="classifyTurns" type="checkbox" class="accent-emerald-500" /> Classificar cada turno
          </label>
        </div>

        <div v-if="settings.current.limitBounds" class="flex flex-col gap-2">
          <h3 class="text-sm font-medium text-zinc-300">Limites</h3>
          <p class="text-xs text-zinc-400">Vazio = vale o padrão do servidor (o número cinza). Cada limite tem mínimo e máximo.</p>
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
              <small class="text-xs text-zinc-500">{{ settings.current.limitBounds[limit.name]?.min }} a {{ settings.current.limitBounds[limit.name]?.max }} · <code>{{ settings.current.limitBounds[limit.name]?.env }}</code></small>
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
        <p class="text-xs text-zinc-400">Decisões do deploy: só leitura aqui. Mudam no <code>.env</code> do servidor, com reinício.</p>
        <dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <div v-for="item in DEPLOYMENT" :key="item.key" class="flex min-w-0 items-baseline justify-between gap-3 border-b border-zinc-800/70 pb-1.5">
            <dt class="text-zinc-400">{{ item.label }}</dt>
            <dd class="min-w-0 truncate font-mono text-xs text-zinc-200" :title="deploymentValue(settings.current.deployment[item.key])">{{ deploymentValue(settings.current.deployment[item.key]) }}</dd>
          </div>
        </dl>
      </section>

      <p v-if="!auth.isAdmin" class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
        As configurações de operação são só de quem administra.
        <RouterLink v-if="!auth.signedIn && auth.localAccounts" :to="{ path: '/login', query: { next: '/settings' } }" class="text-emerald-300 underline">Entrar</RouterLink>
      </p>

      <section v-if="auth.user" id="conta" class="flex scroll-mt-4 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 class="font-medium">Minha conta</h2>
        <p class="text-sm text-zinc-400">{{ auth.user.name }} · {{ auth.user.email }} · {{ auth.user.role === 'admin' ? 'administrador' : 'membro' }}</p>
        <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="changePassword">
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Senha atual
            <input v-model="currentPassword" type="password" required autocomplete="current-password" class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm" />
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Nova senha
            <input v-model="nextPassword" type="password" required autocomplete="new-password" class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm" />
          </label>
          <div class="flex items-center gap-3 sm:col-span-2">
            <button type="submit" class="rounded-full bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700">Trocar senha</button>
            <span v-if="passwordNote" class="text-sm text-emerald-300">{{ passwordNote }}</span>
            <span v-if="passwordError" class="text-sm text-rose-300">{{ passwordError }}</span>
          </div>
        </form>
      </section>

      <AccessTokens v-if="auth.user" />
    </div>
  </div>
</template>
