<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError } from '@/lib/api'
import type { TAudience } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { providerLabel } from '@/lib/format'

const auth = useAuthStore()
const agents = useAgentsStore()
const settings = useSettingsStore()
const providers = useProvidersStore()
const conversations = useConversationsStore()
const router = useRouter()

/** No celular o "Sair" mora aqui (a barra inferior não tem espaço para ele). */
async function logout() {
  await auth.logout()
  conversations.subscribe(auth.isAdmin)
  void conversations.load(auth.isAdmin)
  await router.push('/login')
}

const gatewayToken = ref(auth.gatewayToken)
const tokenNote = ref<string>()

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

/** Os modelos ativados de cada provider ligado — a lista do classificador. */
async function loadClassifierOptions() {
  await providers.load().catch(() => undefined)
  const lists = await Promise.all(
    providers.list
      .filter((provider) => provider.enabled)
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
    model.value = current.model ?? ''
    classifier.value = current.classifierModel ? `${current.classifierProvider ?? ''}::${current.classifierModel}` : ''
    classifyTurns.value = current.classifyTurns ?? false
  },
  { immediate: true },
)

async function saveGatewayToken() {
  await auth.saveGatewayToken(gatewayToken.value)
  conversations.subscribe(auth.isAdmin)
  void conversations.load(auth.isAdmin)
  void agents.load().catch(() => undefined)
  tokenNote.value = auth.unauthorized ? 'O gateway recusou o token.' : 'Salvo.'
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
  try {
    // Vazio vira `null`: volta ao padrão em vez de gravar texto em branco.
    const [classifierProvider, classifierModel] = classifier.value ? classifier.value.split('::') : ['', '']
    await settings.save({
      audience: audience.value,
      agentId: agentId.value || null,
      model: model.value || null,
      classifierModel: classifierModel || null,
      classifierProvider: classifierProvider || null,
      classifyTurns: classifyTurns.value,
    })
    saved.value = 'Configuração salva — vale para a próxima sessão.'
  } catch (error) {
    failure.value = error instanceof ApiError && error.details ? Object.values(error.fieldIssues).flat().join('; ') : String(error)
  }
}
</script>

<template>
  <div class="scroll-thin h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-2xl flex-col gap-6">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-semibold">Configuração</h1>
        <button v-if="auth.user" class="ml-auto rounded-full bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:text-rose-300 md:hidden" @click="logout">Sair</button>
      </div>

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
            <select v-model="agentId" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2">
              <option value="">Padrão ({{ settings.current.defaults?.agentId }})</option>
              <option v-for="option in agents.list" :key="option.id" :value="option.id">{{ option.name }}</option>
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Modelo padrão
            <select v-model="model" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2">
              <option value="">Padrão do agente</option>
              <option v-for="option in agent?.models ?? []" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
            Modelo do classificador
            <select v-model="classifier" class="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2 text-sm">
              <option value="">Nenhum (CLASSIFIER_MODEL, se houver)</option>
              <option v-if="classifier && !classifierOptions.some((option) => option.value === classifier)" :value="classifier">{{ classifier.replace('::', ' · ') }} (não ativado)</option>
              <option v-for="option in classifierOptions" :key="option.value" :value="option.value">{{ providerLabel(option.provider, providers.names) }} · {{ option.model }}</option>
            </select>
            <small class="text-xs text-zinc-500">Os modelos ativados em Providers. Prefira um pequeno: ele roda a cada turno.</small>
          </label>
          <label class="flex items-center gap-2 self-end pb-2 text-sm text-zinc-300">
            <input v-model="classifyTurns" type="checkbox" class="accent-emerald-500" /> Classificar cada turno
          </label>
        </div>

        <div class="flex items-center gap-3">
          <button class="rounded-full bg-emerald-500 px-5 py-2 font-medium text-zinc-950 hover:bg-emerald-400" @click="saveSettings">Salvar</button>
          <span v-if="saved" class="text-sm text-emerald-300">{{ saved }}</span>
          <span v-if="failure" class="text-sm text-rose-300">{{ failure }}</span>
        </div>
        <p v-if="settings.current.updatedBy" class="text-xs text-zinc-500">Última alteração por {{ settings.current.updatedBy }} em {{ new Date(settings.current.updatedAt ?? '').toLocaleString('pt-BR') }}</p>
      </section>

      <p v-else-if="!auth.isAdmin" class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
        As configurações de operação são só de quem administra.
        <RouterLink v-if="!auth.signedIn && auth.localAccounts" :to="{ path: '/login', query: { next: '/settings' } }" class="text-emerald-300 underline">Entrar</RouterLink>
      </p>

      <section v-if="auth.user" class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
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

      <section class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 class="font-medium">Portão do gateway</h2>
        <p class="text-xs text-zinc-400">Só quando o servidor define <code>GATEWAY_TOKEN</code>. Fica neste navegador (localStorage). Quem você é vem do login, não daqui.</p>
        <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
          Token do gateway
          <input v-model="gatewayToken" type="password" autocomplete="off" class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm" />
        </label>
        <div class="flex items-center gap-3">
          <button class="rounded-full bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700" @click="saveGatewayToken">Salvar token</button>
          <span v-if="tokenNote" class="text-sm text-zinc-300">{{ tokenNote }}</span>
        </div>
      </section>
    </div>
  </div>
</template>
