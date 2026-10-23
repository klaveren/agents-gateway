<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AgentAvatar from '@/components/AgentAvatar.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import ProviderModels from '@/components/ProviderModels.vue'
import SubscriptionLogin from '@/components/SubscriptionLogin.vue'
import Icon from '@/components/Icon.vue'
import { ApiError } from '@/lib/api'
import { fullTime } from '@/lib/format'
import type { IProbeResult, IProviderStatus, TProvider } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProvidersStore, type INewProvider } from '@/stores/providers'

const props = defineProps<{ id?: string }>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const providers = useProvidersStore()

/** `/providers/new` abre o formulário no lugar do detalhe. */
const adding = computed(() => route.name === 'provider-new')
const selected = computed(() => (props.id ? providers.list.find((provider) => provider.id === props.id) : undefined))

const ENV_NAME: Record<string, string> = { claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY' }
const CONSOLE: Record<string, string> = {
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
}
const PROTOCOL_LABEL: Record<TProvider, string> = { claude: 'Anthropic', openai: 'OpenAI', google: 'Gemini', 'claude-sub': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' }
/** De onde vem o login de cada assinatura, para o texto da tela. */
const SUBSCRIPTION_HINT: Record<string, string> = {
  'claude-sub': 'Entra com a sua conta Claude (Pro/Max): o gateway gera um token de um ano e o guarda cifrado. No Mac, sem token, vale o login do Claude Code deste computador.',
  codex: 'Entra com a sua conta do ChatGPT. O gateway guarda esse login num lugar só dele, separado do seu Codex.',
  antigravity: 'Entra com a sua conta Google do Antigravity. O gateway guarda esse login num lugar só dele, separado do seu agy.',
}

const drafts = ref<Record<string, string>>({})
const results = ref<Record<string, IProbeResult & { saved?: boolean }>>({})
const busy = ref<Record<string, boolean>>({})
const loadError = ref<string>()
const removingKey = ref<IProviderStatus>()
const removingProvider = ref<IProviderStatus>()
const form = ref<INewProvider>({ id: '', name: '', protocol: 'openai', baseUrl: '', key: '' })
const formIssues = ref<Record<string, string[]>>({})
const formError = ref<string>()

onMounted(async () => {
  if (auth.isAdmin) await providers.load().catch((error) => (loadError.value = error instanceof Error ? error.message : String(error)))
})

function describe(error: unknown): string {
  if (error instanceof ApiError && error.code === 'provider_in_use') return `${error.message}. Troque o provider desses agentes antes.`
  if (error instanceof ApiError && error.status === 422) return Object.values(error.fieldIssues).flat().join('; ') || error.message
  return error instanceof Error ? error.message : String(error)
}

async function run(id: string, work: () => Promise<void>) {
  busy.value = { ...busy.value, [id]: true }
  try {
    await work()
  } catch (error) {
    results.value = { ...results.value, [id]: { ok: false, message: describe(error) } }
  } finally {
    busy.value = { ...busy.value, [id]: false }
  }
}

function test(id: string) {
  return run(id, async () => {
    // O resultado ANTES do spread: com o `await` dentro do objeto, um teste simultâneo apagava o outro.
    const result = await providers.test(id, drafts.value[id]?.trim() || undefined)
    results.value = { ...results.value, [id]: result }
  })
}

/** Testa antes de salvar e mostra o resultado — mas salva mesmo se o teste falhar (rede fora, por ex.). */
function save(id: string) {
  const key = drafts.value[id]?.trim()
  if (!key) return
  return run(id, async () => {
    const probe = await providers.test(id, key).catch((): IProbeResult => ({ ok: false, message: 'não foi possível testar' }))
    await providers.save(id, key)
    drafts.value = { ...drafts.value, [id]: '' }
    results.value = { ...results.value, [id]: { ...probe, saved: true } }
  })
}

function toggle(provider: IProviderStatus) {
  return run(provider.id, () => providers.update(provider.id, { enabled: !provider.enabled }))
}

async function confirmRemoveKey() {
  const target = removingKey.value
  if (!target) return
  await run(target.id, async () => {
    await providers.clear(target.id)
    results.value = { ...results.value, [target.id]: { ok: true, message: 'Chave removida.' } }
  })
  removingKey.value = undefined
}

async function confirmRemoveProvider() {
  const target = removingProvider.value
  if (!target) return
  await run(target.id, () => providers.remove(target.id))
  removingProvider.value = undefined
  if (!providers.list.some((provider) => provider.id === target.id)) await router.push('/providers')
}

async function create() {
  formIssues.value = {}
  formError.value = undefined
  try {
    const id = form.value.id
    await providers.create({ ...form.value, key: form.value.key?.trim() || undefined })
    form.value = { id: '', name: '', protocol: 'openai', baseUrl: '', key: '' }
    await router.push(`/providers/${id}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) formIssues.value = error.fieldIssues
    formError.value = describe(error)
  }
}

/** A linha de baixo na lista: o que falta, ou o resumo. */
function rowStatus(provider: IProviderStatus): string {
  if (!provider.enabled) return 'desligado'
  if (provider.subscription) return `assinatura · ${provider.catalog ? `${provider.catalog.enabled} de ${provider.catalog.total} modelos` : 'modelos não listados'}`
  if (!provider.credential.configured) return 'sem chave'
  const models = provider.catalog ? `${provider.catalog.enabled} de ${provider.catalog.total} modelos` : 'modelos não listados'
  return `${provider.official ? 'oficial' : `compatível ${PROTOCOL_LABEL[provider.protocol]}`} · ${models}`
}

function sourceLabel(provider: IProviderStatus): string {
  const credential = provider.credential
  if (provider.subscription) return credential.source === 'stored' ? `Token salvo pela tela · termina em …${credential.last4}` : 'Pela assinatura, sem chave de API'
  if (credential.source === 'stored') return `Chave salva pela tela · termina em …${credential.last4}`
  if (credential.source === 'env') return `Chave do .env (${ENV_NAME[provider.id]}) · termina em …${credential.last4}`
  return 'Sem chave'
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <div>
      <p class="font-medium text-zinc-200">Só quem administra configura os providers.</p>
      <RouterLink v-if="!auth.signedIn && auth.localAccounts" :to="{ path: '/login', query: { next: '/providers' } }" class="mt-3 inline-block rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950">Entrar</RouterLink>
    </div>
  </div>

  <MasterDetail v-else :open="!!id || adding" back-to="/providers" back-label="Providers" :title="adding ? 'Novo provider' : selected?.name">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-1">
        <h1 class="text-xl font-semibold">Providers</h1>
        <RouterLink to="/providers/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Adicionar provider"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <p class="px-4 pb-3 text-xs text-zinc-500">Os oficiais e qualquer API compatível com OpenAI ou Anthropic. As chaves ficam criptografadas e nunca voltam para a tela.</p>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <RouterLink
        v-for="provider in providers.list"
        :key="provider.id"
        :to="`/providers/${provider.id}`"
        class="mx-2 flex items-center gap-3 rounded-xl px-3 py-2"
        :class="[provider.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60', { 'opacity-60': !provider.enabled }]"
      >
        <AgentAvatar :name="provider.name" :provider="provider.id" size="sm" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ provider.name }}</span>
          <span class="block truncate text-xs" :class="provider.enabled && !provider.credential.configured && !provider.subscription ? 'text-amber-300' : 'text-zinc-500'">{{ rowStatus(provider) }}</span>
        </span>
        <span class="h-2 w-2 shrink-0 rounded-full" :class="provider.enabled && (provider.credential.configured || provider.subscription) ? 'bg-emerald-400' : 'bg-zinc-600'" :title="provider.enabled ? 'Ligado' : 'Desligado'" />
      </RouterLink>
    </template>

    <template #detail>
      <template v-if="adding">
        <h2 class="mx-auto mb-4 max-w-3xl text-lg font-semibold">Novo provider</h2>
        <form class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="create">
          <div class="flex flex-wrap gap-1.5">
            <span class="text-xs text-zinc-400">Qualquer API que imite a da OpenAI ou a da Anthropic — um agregador, um servidor local, um gateway da empresa.</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">Nome<input v-model="form.name" required class="input" /><small v-for="m in formIssues.name" :key="m" class="error">{{ m }}</small></label>
            <label class="field">Id<input v-model="form.id" required pattern="[a-z0-9][a-z0-9-]{1,31}" class="input font-mono" placeholder="meu-provider" /><small v-for="m in formIssues.id" :key="m" class="error">{{ m }}</small></label>
            <div class="field">
              Protocolo
              <div class="flex flex-wrap gap-1.5">
                <button v-for="protocol in (['openai', 'claude'] as TProvider[])" :key="protocol" type="button" class="chip" :class="{ on: form.protocol === protocol }" @click="form.protocol = protocol">{{ PROTOCOL_LABEL[protocol] }}</button>
              </div>
              <small class="hint">Qual API o provider imita — é o que decide o formato da URL abaixo. Alguns falam as duas: cadastre um de cada, se quiser usar as duas lanes de SDK.</small>
            </div>
            <label class="field">
              URL base
              <input v-model="form.baseUrl" required class="input font-mono" :placeholder="form.protocol === 'claude' ? 'https://api.exemplo.com' : 'https://api.exemplo.com/v1'" />
              <small class="hint">{{ form.protocol === 'claude' ? 'Sem o /v1: o SDK da Anthropic acrescenta.' : 'Com o /v1: o SDK da OpenAI acrescenta só /chat/completions.' }}</small>
              <small v-for="m in formIssues.baseUrl" :key="m" class="error">{{ m }}</small>
            </label>
            <label class="field sm:col-span-2">Chave (opcional agora)<input v-model="form.key" type="password" autocomplete="off" spellcheck="false" class="input font-mono" /></label>
          </div>
          <p class="text-xs text-amber-300/80">Nos compatíveis, tool use e raciocínio variam por modelo: um agente com ferramentas pode falhar onde o GPT ou o Claude não falham.</p>
          <p v-if="formError && !Object.keys(formIssues).length" class="text-sm text-rose-300">{{ formError }}</p>
          <div class="flex gap-2">
            <button type="submit" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">Adicionar</button>
            <RouterLink to="/providers" class="rounded-full px-4 py-2 text-sm hover:bg-zinc-800">Cancelar</RouterLink>
          </div>
        </form>
      </template>
      <section v-else-if="selected" :key="selected.id" class="mx-auto flex max-w-3xl flex-col gap-4">
        <div class="flex items-center gap-3">
          <AgentAvatar :name="selected.name" :provider="selected.id" size="lg" />
          <div class="min-w-0">
            <h2 class="text-lg font-semibold">{{ selected.name }} <span class="ml-1 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-normal text-zinc-400">{{ selected.subscription ? 'assinatura' : selected.official ? 'oficial' : `compatível ${PROTOCOL_LABEL[selected.protocol]}` }}</span></h2>
            <p class="text-xs break-all" :class="selected.credential.configured || selected.subscription ? 'text-zinc-400' : 'text-amber-300'">
              {{ sourceLabel(selected) }}<template v-if="selected.baseUrl"> · <code>{{ selected.baseUrl }}</code></template>
            </p>
          </div>
          <label class="ml-auto flex shrink-0 items-center gap-2 text-xs text-zinc-400">
            Ligado
            <button type="button" role="switch" :aria-checked="selected.enabled" class="switch" :class="{ on: selected.enabled }" :disabled="busy[selected.id]" @click="toggle(selected)"><span /></button>
          </label>
        </div>

        <p v-if="selected.credential.unreadable" class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          A chave salva não pôde ser decifrada (a chave-mestra mudou). Cole a chave de novo{{ selected.credential.source === 'env' ? ' — até lá, vale a do .env' : '' }}.
        </p>
        <p v-if="selected.credential.updatedBy && selected.credential.source === 'stored'" class="text-xs text-zinc-500">Chave salva por {{ selected.credential.updatedBy }} em {{ fullTime(selected.credential.updatedAt) }}</p>

        <template v-if="selected.subscription">
          <p class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            Conta pessoal: os agentes usam a SUA assinatura, então só quem administra conversa com eles (SUBSCRIPTION_ADMIN_ONLY). Cada conversa roda num diretório vazio, sem terminal nem acesso ao disco
            deste servidor. Os preços dos modelos são os da API, para mostrar quanto a conversa custaria em tokens.
          </p>
          <p class="text-xs text-zinc-400">{{ SUBSCRIPTION_HINT[selected.protocol] }}</p>
          <SubscriptionLogin :provider="selected" @done="providers.load().then(() => test(selected!.id))" />
          <div v-if="selected.protocol !== 'claude-sub'" class="flex">
            <button type="button" :disabled="busy[selected.id]" class="rounded-full bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-40" @click="test(selected.id)">{{ busy[selected.id] ? 'Testando…' : 'Testar' }}</button>
          </div>
        </template>

        <form v-if="!selected.subscription || selected.protocol === 'claude-sub'" class="flex flex-wrap items-center gap-2" @submit.prevent="save(selected.id)">
          <input
            v-model="drafts[selected.id]"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="selected.subscription ? 'Token OAuth (opcional)' : selected.credential.configured ? 'Colar nova chave para trocar' : 'Colar a chave de API'"
            class="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/60"
          />
          <button type="button" :disabled="busy[selected.id] || (!drafts[selected.id] && !selected.credential.configured && !selected.subscription)" class="rounded-full bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-40" @click="test(selected.id)">Testar</button>
          <button type="submit" :disabled="busy[selected.id] || !drafts[selected.id]?.trim()" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">Salvar</button>
          <button v-if="selected.credential.source === 'stored'" type="button" class="rounded-full px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10" @click="removingKey = selected">Remover chave</button>
        </form>

        <p v-if="results[selected.id]" class="text-sm" :class="results[selected.id].ok ? 'text-emerald-300' : 'text-rose-300'">
          <template v-if="results[selected.id].saved">Salva. </template>
          <template v-if="results[selected.id].ok && results[selected.id].unverified">⚠ {{ results[selected.id].message }} ({{ results[selected.id].models }} modelos listados)</template>
          <template v-else-if="results[selected.id].ok && results[selected.id].models !== undefined">✓ A chave funciona — {{ results[selected.id].models }} modelos disponíveis.</template>
          <template v-else-if="results[selected.id].ok">{{ results[selected.id].message }}</template>
          <template v-else>✕ {{ results[selected.id].status ? `HTTP ${results[selected.id].status}: ` : '' }}{{ results[selected.id].message }}</template>
        </p>

        <ProviderModels :provider="selected" />

        <div class="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          <span>Agentes:</span>
          <span v-for="agent in selected.agents" :key="agent.id" class="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">{{ agent.name }}</span>
          <span v-if="!selected.agents.length">nenhum ainda</span>
          <a v-if="CONSOLE[selected.id] && !selected.subscription" :href="CONSOLE[selected.id]" target="_blank" rel="noopener noreferrer" class="ml-auto text-emerald-400 hover:underline">Gerar chave ↗</a>
          <button v-if="!selected.official" type="button" class="ml-auto text-rose-300 hover:underline" @click="removingProvider = selected">Remover provider</button>
        </div>
      </section>
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um provider ou adicione um novo.</div>
      <ConfirmDialog
        :open="!!removingKey"
        :title="`Remover a chave salva de ${removingKey?.name ?? ''}?`"
        :message="removingKey?.official ? 'A próxima chamada passa a usar a chave do .env, se houver; sem ela, as conversas com esse provider falham até uma chave nova ser salva.' : 'Sem chave, as conversas com esse provider falham até uma nova ser salva.'"
        action="Remover"
        @confirm="confirmRemoveKey"
        @cancel="removingKey = undefined"
      />
      <ConfirmDialog
        :open="!!removingProvider"
        :title="`Remover o provider ${removingProvider?.name ?? ''}?`"
        message="O provider e a chave dele somem. Se algum agente ainda o usa, o gateway recusa e diz quais."
        action="Remover"
        @confirm="confirmRemoveProvider"
        @cancel="removingProvider = undefined"
      />
    </template>
  </MasterDetail>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex flex-col gap-1.5 text-sm font-medium text-zinc-300;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
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
.switch {
  @apply relative h-6 w-11 rounded-full bg-zinc-700 transition-colors disabled:opacity-40;
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
