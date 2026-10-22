<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AgentAvatar from '@/components/AgentAvatar.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { ApiError } from '@/lib/api'
import { fullTime, PROVIDER_LABEL } from '@/lib/format'
import type { IProbeResult, IProviderStatus, TProvider } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProvidersStore } from '@/stores/providers'

const auth = useAuthStore()
const providers = useProvidersStore()

const ENV_NAME: Record<TProvider, string> = { claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY' }
const CONSOLE: Record<TProvider, string> = {
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
}

const drafts = ref<Record<string, string>>({})
const results = ref<Record<string, IProbeResult & { saved?: boolean }>>({})
const busy = ref<Record<string, boolean>>({})
const loadError = ref<string>()
const removing = ref<IProviderStatus>()

onMounted(async () => {
  if (auth.isAdmin) await providers.load().catch((error) => (loadError.value = error instanceof Error ? error.message : String(error)))
})

async function run(provider: TProvider, work: () => Promise<void>) {
  busy.value = { ...busy.value, [provider]: true }
  try {
    await work()
  } catch (error) {
    const message = error instanceof ApiError && error.status === 422 ? 'A chave não tem o formato esperado (sem espaços, pelo menos 8 caracteres).' : error instanceof Error ? error.message : String(error)
    results.value = { ...results.value, [provider]: { ok: false, message } }
  } finally {
    busy.value = { ...busy.value, [provider]: false }
  }
}

function test(provider: TProvider) {
  return run(provider, async () => {
    // O resultado ANTES do spread: com o `await` dentro do objeto, o spread era lido antes da espera e
    // um teste simultâneo em outro provider apagava este.
    const result = await providers.test(provider, drafts.value[provider]?.trim() || undefined)
    results.value = { ...results.value, [provider]: result }
  })
}

/** Testa antes de salvar e mostra o resultado — mas salva mesmo se o teste falhar (rede fora, por ex.). */
function save(provider: TProvider) {
  const key = drafts.value[provider]?.trim()
  if (!key) return
  return run(provider, async () => {
    const probe = await providers.test(provider, key).catch((): IProbeResult => ({ ok: false, message: 'não foi possível testar' }))
    await providers.save(provider, key)
    drafts.value = { ...drafts.value, [provider]: '' }
    results.value = { ...results.value, [provider]: { ...probe, saved: true } }
  })
}

async function confirmRemove() {
  const target = removing.value
  if (!target) return
  await run(target.provider, async () => {
    await providers.clear(target.provider)
    results.value = { ...results.value, [target.provider]: { ok: true, message: 'Chave removida.' } }
  })
  removing.value = undefined
}

function sourceLabel(status: IProviderStatus): string {
  if (status.source === 'stored') return `Salva pela tela · termina em …${status.last4}`
  if (status.source === 'env') return `Do .env (${ENV_NAME[status.provider]}) · termina em …${status.last4}`
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

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-3xl flex-col gap-4">
      <header>
        <h1 class="text-xl font-semibold">Providers</h1>
        <p class="mt-1 text-sm text-zinc-400">As chaves de API de cada fornecedor. Ficam criptografadas no banco, valem na próxima chamada (sem reiniciar) e nunca voltam para a tela. A chave salva aqui vence a do <code>.env</code>.</p>
      </header>
      <p v-if="loadError" class="text-sm text-rose-300">{{ loadError }}</p>

      <section v-for="status in providers.list" :key="status.provider" class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div class="flex items-center gap-3">
          <AgentAvatar :name="PROVIDER_LABEL[status.provider]" :provider="status.provider" size="sm" />
          <div class="min-w-0">
            <h2 class="font-medium">{{ PROVIDER_LABEL[status.provider] }}</h2>
            <p class="text-xs" :class="status.configured ? 'text-zinc-400' : 'text-amber-300'">{{ sourceLabel(status) }}</p>
          </div>
          <span class="ml-auto rounded-full px-2.5 py-0.5 text-xs" :class="status.configured ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-400'">{{ status.configured ? 'configurado' : 'não configurado' }}</span>
        </div>

        <p v-if="status.unreadable" class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          A chave salva não pôde ser decifrada (a chave-mestra mudou). Cole a chave de novo{{ status.source === 'env' ? ' — até lá, vale a do .env' : '' }}.
        </p>
        <p v-if="status.updatedBy && status.source === 'stored'" class="text-xs text-zinc-500">Salva por {{ status.updatedBy }} em {{ fullTime(status.updatedAt) }}</p>

        <form class="flex flex-wrap items-center gap-2" @submit.prevent="save(status.provider)">
          <input
            v-model="drafts[status.provider]"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="status.configured ? 'Colar nova chave para trocar' : 'Colar a chave de API'"
            class="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/60"
          />
          <button type="button" :disabled="busy[status.provider] || (!drafts[status.provider] && !status.configured)" class="rounded-full bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-40" @click="test(status.provider)">Testar</button>
          <button type="submit" :disabled="busy[status.provider] || !drafts[status.provider]?.trim()" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">Salvar</button>
          <button v-if="status.source === 'stored'" type="button" class="rounded-full px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10" @click="removing = status">Remover</button>
        </form>

        <p v-if="results[status.provider]" class="text-sm" :class="results[status.provider].ok ? 'text-emerald-300' : 'text-rose-300'">
          <template v-if="results[status.provider].saved">Salva. </template>
          <template v-if="results[status.provider].ok && results[status.provider].models !== undefined">✓ A chave funciona — {{ results[status.provider].models }} modelos disponíveis.</template>
          <template v-else-if="results[status.provider].ok">{{ results[status.provider].message }}</template>
          <template v-else>✕ {{ results[status.provider].status ? `HTTP ${results[status.provider].status}: ` : '' }}{{ results[status.provider].message }}</template>
        </p>

        <div class="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          <span>Libera:</span>
          <span v-for="model in status.models" :key="model" class="rounded-full bg-zinc-800 px-2 py-0.5 font-mono text-zinc-300">{{ model }}</span>
          <span v-if="!status.models.length">nenhum agente usa este provider ainda</span>
          <a :href="CONSOLE[status.provider]" target="_blank" rel="noopener noreferrer" class="ml-auto text-emerald-400 hover:underline">Gerar chave ↗</a>
        </div>
      </section>
    </div>

    <ConfirmDialog
      :open="!!removing"
      :title="`Remover a chave salva de ${removing ? PROVIDER_LABEL[removing.provider] : ''}?`"
      :message="'A próxima chamada passa a usar a chave do .env, se houver; sem ela, as conversas com esse provider falham até uma chave nova ser salva.'"
      action="Remover"
      @confirm="confirmRemove"
      @cancel="removing = undefined"
    />
  </div>
</template>
