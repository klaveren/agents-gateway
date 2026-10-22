<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import type { TAudience } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useSettingsStore } from '@/stores/settings'

const auth = useAuthStore()
const agents = useAgentsStore()
const settings = useSettingsStore()
const conversations = useConversationsStore()

const gatewayToken = ref(auth.gatewayToken)
const callerToken = ref(auth.callerToken)
const tokenNote = ref<string>()

const audience = ref<TAudience>('all')
const agentId = ref('')
const model = ref('')
const classifierModel = ref('')
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
  if (auth.isAdmin) await settings.load().catch((error) => (failure.value = String(error)))
})

watch(
  () => settings.current,
  (current) => {
    if (!current) return
    audience.value = current.audience
    agentId.value = current.agentId ?? ''
    model.value = current.model ?? ''
    classifierModel.value = current.classifierModel ?? ''
    classifyTurns.value = current.classifyTurns ?? false
  },
  { immediate: true },
)

async function saveTokens() {
  await auth.saveTokens(gatewayToken.value, callerToken.value)
  // Outra credencial é outra pessoa: lista, agentes e assinatura ao vivo recomeçam com ela.
  conversations.subscribe(auth.isAdmin)
  void conversations.load(auth.isAdmin)
  void agents.load().catch(() => undefined)
  if (auth.isAdmin) void settings.load().catch(() => undefined)
  tokenNote.value = auth.unauthorized ? 'O gateway recusou essas credenciais.' : auth.isAdmin ? 'Salvo. Você é administrador.' : 'Salvo.'
}

async function saveSettings() {
  saved.value = undefined
  failure.value = undefined
  try {
    // Vazio vira `null`: volta ao padrão em vez de gravar texto em branco.
    await settings.save({ audience: audience.value, agentId: agentId.value || null, model: model.value || null, classifierModel: classifierModel.value || null, classifyTurns: classifyTurns.value })
    saved.value = 'Configuração salva — vale para a próxima sessão.'
  } catch (error) {
    failure.value = error instanceof ApiError && error.details ? Object.values(error.fieldIssues).flat().join('; ') : String(error)
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
          <label class="flex flex-col gap-1 text-sm text-zinc-300">
            Agente padrão
            <select v-model="agentId" class="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2">
              <option value="">Padrão ({{ settings.current.defaults?.agentId }})</option>
              <option v-for="option in agents.list" :key="option.id" :value="option.id">{{ option.name }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-sm text-zinc-300">
            Modelo padrão
            <select v-model="model" class="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2">
              <option value="">Padrão do agente</option>
              <option v-for="option in agent?.models ?? []" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-sm text-zinc-300">
            Modelo do classificador
            <input v-model="classifierModel" class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm" placeholder="ex.: claude-haiku-5" />
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
        As configurações de operação são só de quem administra. O gateway reconhece administrador pela identidade provada (<code>CALLER_PROOF_TOOL</code>) com papel em <code>ADMIN_ROLES</code> ou nome em <code>ADMIN_USERS</code>.
      </p>

      <section class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 class="font-medium">Credenciais deste navegador</h2>
        <p class="text-xs text-zinc-400">Ficam só aqui (localStorage). O token do gateway é o portão do serviço (<code>GATEWAY_TOKEN</code>); o do chamador identifica você e é repassado às ferramentas.</p>
        <label class="flex flex-col gap-1 text-sm text-zinc-300">
          Token do gateway
          <input v-model="gatewayToken" type="password" autocomplete="off" class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm" />
        </label>
        <label class="flex flex-col gap-1 text-sm text-zinc-300">
          Credencial do chamador
          <input v-model="callerToken" type="password" autocomplete="off" class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm" />
        </label>
        <div class="flex items-center gap-3">
          <button class="rounded-full bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700" @click="saveTokens">Salvar credenciais</button>
          <span v-if="tokenNote" class="text-sm text-zinc-300">{{ tokenNote }}</span>
        </div>
      </section>
    </div>
  </div>
</template>
