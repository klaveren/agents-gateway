<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '@/lib/api'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'

/** Login e setup do primeiro admin: a mesma tela, porque são os mesmos campos menos um. */
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const agents = useAgentsStore()
const conversations = useConversationsStore()

const isSetup = computed(() => route.name === 'setup')
const name = ref('')
const email = ref('')
const password = ref('')
const code = ref('')
const confirm = ref('')
const error = ref<string>()
const issues = ref<Record<string, string[]>>({})
const busy = ref(false)

async function submit() {
  error.value = undefined
  issues.value = {}
  if (isSetup.value && password.value !== confirm.value) {
    issues.value = { confirm: ['as senhas não conferem'] }
    return
  }

  busy.value = true
  try {
    if (isSetup.value) await auth.setup({ name: name.value, email: email.value, password: password.value, code: code.value.trim() })
    else await auth.login(email.value, password.value)

    // Outra pessoa: lista, agentes e assinatura ao vivo recomeçam com a credencial nova.
    conversations.subscribe(auth.isAdmin)
    void conversations.load(auth.isAdmin)
    void agents.load().catch(() => undefined)
    await router.replace(String(route.query.next ?? '/'))
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) issues.value = failure.fieldIssues
    else if (failure instanceof ApiError && failure.code === 'login_locked') error.value = 'Muitas tentativas. Espere alguns minutos e tente de novo.'
    else if (failure instanceof ApiError && failure.code === 'invalid_credentials') error.value = 'E-mail ou senha inválidos.'
    else if (failure instanceof ApiError && isSetup.value && failure.status === 404) error.value = 'Código errado, ou já existe uma conta.'
    else error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="grid h-full place-items-center overflow-y-auto p-4">
    <form class="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl" @submit.prevent="submit">
      <div class="mb-5 flex items-center gap-3">
        <div class="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 text-sm font-bold text-zinc-950">AG</div>
        <div>
          <h1 class="font-semibold">{{ isSetup ? 'Criar o primeiro administrador' : 'Entrar' }}</h1>
          <p class="text-xs text-zinc-400">{{ isSetup ? 'Só na primeira vez.' : 'Agents Gateway' }}</p>
        </div>
      </div>

      <label v-if="isSetup" class="field">
        Código de instalação
        <input v-model="code" required autocomplete="off" spellcheck="false" placeholder="AB12-CD34-EF56" class="input font-mono uppercase" />
        <small class="hint">O código está no log do servidor, na linha [setup].</small>
      </label>
      <label v-if="isSetup" class="field">
        Nome
        <input v-model="name" required autocomplete="name" class="input" />
        <small v-for="message in issues.name" :key="message" class="error">{{ message }}</small>
      </label>
      <label class="field">
        E-mail
        <input v-model="email" type="email" required autocomplete="username" class="input" />
        <small v-for="message in issues.email" :key="message" class="error">{{ message }}</small>
      </label>
      <label class="field">
        Senha
        <input v-model="password" type="password" required :autocomplete="isSetup ? 'new-password' : 'current-password'" class="input" />
        <small v-if="isSetup" class="text-xs font-normal text-zinc-500">Pelo menos 10 caracteres. Uma frase serve.</small>
        <small v-for="message in issues.password" :key="message" class="error">{{ message }}</small>
      </label>
      <label v-if="isSetup" class="field">
        Confirmar senha
        <input v-model="confirm" type="password" required autocomplete="new-password" class="input" />
        <small v-for="message in issues.confirm" :key="message" class="error">{{ message }}</small>
      </label>

      <p v-if="error" class="mb-3 text-sm text-rose-300">{{ error }}</p>
      <button type="submit" :disabled="busy" class="w-full rounded-full bg-emerald-500 py-2.5 font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
        {{ busy ? 'Aguarde…' : isSetup ? 'Criar e entrar' : 'Entrar' }}
      </button>
      <RouterLink v-if="!isSetup" to="/" class="mt-3 block text-center text-xs text-zinc-500 hover:text-zinc-300">Continuar sem entrar</RouterLink>
    </form>
  </div>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply mb-3 flex flex-col gap-1.5 text-sm font-medium text-zinc-300;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
.error {
  @apply text-xs font-normal text-rose-300;
}
.hint {
  @apply text-xs font-normal text-zinc-500;
}
</style>
