<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { IProviderStatus, ISubscriptionLogin } from '@/lib/types'
import { useProvidersStore } from '@/stores/providers'

/**
 * Entrar numa assinatura pela tela: o gateway roda o login oficial do cliente (num HOME só dele) e
 * devolve o link — e, no ChatGPT, o código de dispositivo; no Antigravity, a página devolve um código
 * que se cola aqui.
 */
const props = defineProps<{ provider: IProviderStatus }>()
const emit = defineEmits<{ done: [] }>()
const providers = useProvidersStore()

const login = ref<ISubscriptionLogin>({ state: 'idle', needsCode: false })
const code = ref('')
const busy = ref(false)
const error = ref<string>()
const copied = ref<string>()
const now = ref(Date.now())
let poll: ReturnType<typeof setInterval> | undefined

const secondsLeft = computed(() => (login.value.expiresAt ? Math.max(0, Math.round((Date.parse(login.value.expiresAt) - now.value) / 1000)) : undefined))

async function act(work: () => Promise<ISubscriptionLogin>) {
  busy.value = true
  error.value = undefined
  try {
    login.value = await work()
    watchLogin()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}

/** Enquanto espera, pergunta a cada 2 s — o login termina no navegador, não aqui. */
function watchLogin() {
  stop()
  if (login.value.state !== 'waiting') {
    if (login.value.state === 'done') emit('done')
    return
  }
  poll = setInterval(async () => {
    now.value = Date.now()
    try {
      login.value = await providers.login(props.provider.id, 'status')
    } catch {
      return
    }
    if (login.value.state !== 'waiting') watchLogin()
  }, 2000)
}

function stop() {
  if (poll) clearInterval(poll)
  poll = undefined
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = what
    setTimeout(() => (copied.value = undefined), 1500)
  } catch {
    copied.value = undefined
  }
}

function start() {
  code.value = ''
  return act(() => providers.login(props.provider.id, 'start'))
}

function send() {
  const value = code.value.trim()
  if (!value) return
  return act(() => providers.loginCode(props.provider.id, value))
}

onBeforeUnmount(stop)
</script>

<template>
  <div class="flex flex-col gap-3 rounded-xl border border-zinc-800 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-sm font-medium">Conta</span>
      <span v-if="login.state === 'done'" class="text-sm text-emerald-300">✓ Conectado</span>
      <span v-else-if="login.state === 'failed'" class="text-sm text-rose-300">✕ {{ login.message }}</span>
      <button v-if="login.state !== 'waiting'" type="button" :disabled="busy" class="ml-auto rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="start">
        {{ busy ? 'Abrindo…' : 'Entrar' }}
      </button>
      <button v-else type="button" class="ml-auto rounded-full px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800" @click="act(() => providers.login(provider.id, 'cancel'))">Cancelar</button>
    </div>

    <template v-if="login.state === 'waiting'">
      <ol class="flex list-decimal flex-col gap-2 pl-5 text-sm text-zinc-300">
        <li>
          Abra o link e entre na conta:
          <div v-if="login.url" class="mt-1 flex items-center gap-2">
            <a :href="login.url" target="_blank" rel="noopener noreferrer" class="min-w-0 flex-1 truncate font-mono text-xs text-emerald-400 hover:underline">{{ login.url }}</a>
            <button type="button" class="shrink-0 rounded-full bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700" @click="copy(login.url, 'url')">{{ copied === 'url' ? 'Copiado' : 'Copiar' }}</button>
          </div>
          <p v-else class="text-xs text-zinc-500">aguardando o link…</p>
        </li>
        <li v-if="login.userCode">
          Digite este código na página:
          <div class="mt-1 flex items-center gap-2">
            <code class="rounded-lg bg-zinc-950 px-3 py-1.5 font-mono text-base tracking-widest">{{ login.userCode }}</code>
            <button type="button" class="rounded-full bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700" @click="copy(login.userCode, 'code')">{{ copied === 'code' ? 'Copiado' : 'Copiar' }}</button>
          </div>
        </li>
        <li v-if="login.needsCode">
          Se a página mostrar um código, cole aqui (abrindo no mesmo computador do gateway, ela conclui sozinha):
          <form class="mt-1 flex gap-2" @submit.prevent="send">
            <input v-model="code" autocomplete="off" spellcheck="false" placeholder="código de autorização" class="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/60" />
            <button type="submit" :disabled="busy || !code.trim()" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-40">Enviar</button>
          </form>
        </li>
      </ol>
      <p class="text-xs text-zinc-500">
        Aguardando o login<template v-if="secondsLeft !== undefined"> · expira em {{ secondsLeft >= 120 ? `${Math.round(secondsLeft / 60)} min` : `${secondsLeft} s` }}</template>
      </p>
    </template>
    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
  </div>
</template>
