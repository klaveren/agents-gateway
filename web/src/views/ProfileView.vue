<script setup lang="ts">
import { ref } from 'vue'
import AccessTokens from '@/components/AccessTokens.vue'
import { ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

/** O perfil: o que é da PESSOA (conta, senha, tokens de acesso). O que é do sistema mora em Configuração. */
const auth = useAuthStore()

const currentPassword = ref('')
const nextPassword = ref('')
const passwordNote = ref<string>()
const passwordError = ref<string>()

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
</script>

<template>
  <div class="scroll-thin h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 class="text-xl font-semibold">Perfil</h1>

      <p v-if="!auth.user" class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
        Entre para ver a sua conta.
        <RouterLink v-if="auth.localAccounts" :to="{ path: '/login', query: { next: '/profile' } }" class="text-emerald-300 underline">Entrar</RouterLink>
      </p>

      <template v-else>
        <section class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 class="font-medium">Minha conta</h2>
          <dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div class="min-w-0"><dt class="text-xs text-zinc-500">Nome</dt><dd class="truncate text-zinc-200">{{ auth.user.name }}</dd></div>
            <div class="min-w-0"><dt class="text-xs text-zinc-500">E-mail</dt><dd class="truncate text-zinc-200">{{ auth.user.email }}</dd></div>
            <div class="min-w-0"><dt class="text-xs text-zinc-500">Papel</dt><dd class="text-zinc-200">{{ auth.user.role === 'admin' ? 'administrador' : 'membro' }}</dd></div>
          </dl>
        </section>

        <section class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 class="font-medium">Senha</h2>
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
              <button type="submit" class="btn btn-secondary">Trocar senha</button>
              <span v-if="passwordNote" class="text-sm text-emerald-300">{{ passwordNote }}</span>
              <span v-if="passwordError" class="text-sm text-rose-300">{{ passwordError }}</span>
            </div>
          </form>
        </section>

        <AccessTokens />
      </template>
    </div>
  </div>
</template>
