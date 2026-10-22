<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import { ApiError } from '@/lib/api'
import { fullTime, initials } from '@/lib/format'
import type { IUser, TUserRole } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useUsersStore } from '@/stores/users'

const auth = useAuthStore()
const users = useUsersStore()

const loadError = ref<string>()
const rowError = ref<Record<string, string>>({})

/** Mudança que pede confirmação: dar ou tirar admin, desativar ou reativar. */
interface IPending {
  user: IUser
  change: { role?: TUserRole; disabled?: boolean }
  title: string
  message: string
  action: string
}
const pending = ref<IPending>()
const applying = ref(false)

const creating = ref(false)
const form = ref({ name: '', email: '', password: '', role: 'member' as TUserRole })
const formIssues = ref<Record<string, string[]>>({})
const formError = ref<string>()

const resetting = ref<IUser>()
const resetPassword = ref('')
const resetError = ref<string>()
const resetDone = ref<string>()

const activeAdmins = computed(() => users.list.filter((user) => user.role === 'admin' && !user.disabled).length)

onMounted(async () => {
  if (!auth.isAdmin) return
  await users.load().catch((error) => (loadError.value = error instanceof Error ? error.message : String(error)))
})

function askRole(user: IUser) {
  const toAdmin = user.role !== 'admin'
  pending.value = {
    user,
    change: { role: toAdmin ? 'admin' : 'member' },
    title: toAdmin ? `Tornar ${user.name} administrador?` : `Tirar o admin de ${user.name}?`,
    message: toAdmin
      ? 'Administrador cria e edita agentes (inclusive com ferramentas como run_bash), vê todas as conversas e muda a configuração do gateway.'
      : 'A sessão atual dele cai na hora; ao entrar de novo, volta como membro.',
    action: toAdmin ? 'Tornar admin' : 'Tirar admin',
  }
}

function askDisabled(user: IUser) {
  const disable = !user.disabled
  pending.value = {
    user,
    change: { disabled: disable },
    title: disable ? `Desativar ${user.name}?` : `Reativar ${user.name}?`,
    message: disable ? 'A conta deixa de entrar e a sessão atual cai na hora. As conversas dela continuam gravadas.' : 'A conta volta a poder entrar com a senha que tinha.',
    action: disable ? 'Desativar' : 'Reativar',
  }
}

async function apply() {
  const current = pending.value
  if (!current) return
  applying.value = true
  // Um erro antigo (de outra tentativa, noutra linha) não pode continuar acusando o que já mudou.
  rowError.value = {}
  try {
    await users.update(current.user.id, current.change)
    pending.value = undefined
    // A própria conta mudou de papel: o token antigo não vale mais, a sessão é refeita.
    if (current.user.id === auth.user?.id) await auth.probe()
  } catch (error) {
    const message = error instanceof ApiError && error.status === 422 ? Object.values(error.fieldIssues).flat().join('; ') : error instanceof Error ? error.message : String(error)
    rowError.value = { ...rowError.value, [current.user.id]: translate(message) }
    pending.value = undefined
  } finally {
    applying.value = false
  }
}

function translate(message: string): string {
  return message
    .replace('the last active administrator cannot be removed', 'é o último administrador ativo — torne outra conta admin antes')
    .replace('you cannot disable your own account', 'você não pode desativar a própria conta')
}

async function create() {
  formIssues.value = {}
  formError.value = undefined
  try {
    await users.create(form.value)
    rowError.value = {}
    form.value = { name: '', email: '', password: '', role: 'member' }
    creating.value = false
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) formIssues.value = error.fieldIssues
    else formError.value = error instanceof Error ? error.message : String(error)
  }
}

async function doReset() {
  if (!resetting.value) return
  resetError.value = undefined
  try {
    await users.resetPassword(resetting.value.id, resetPassword.value)
    resetDone.value = `Senha de ${resetting.value.name} redefinida. Passe a nova senha a ela por um canal seguro.`
    resetting.value = undefined
    resetPassword.value = ''
  } catch (error) {
    resetError.value = error instanceof ApiError && error.status === 422 ? Object.values(error.fieldIssues).flat().join('; ') : String(error)
  }
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <div>
      <p class="font-medium text-zinc-200">Só quem administra gerencia usuários.</p>
      <RouterLink v-if="!auth.signedIn" :to="{ path: '/login', query: { next: '/users' } }" class="mt-3 inline-block rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950">Entrar</RouterLink>
    </div>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-3xl flex-col gap-4">
      <header class="flex items-center gap-2">
        <h1 class="text-xl font-semibold">Usuários</h1>
        <span class="text-sm text-zinc-500">{{ users.list.length }}</span>
        <button class="ml-auto flex items-center gap-1.5 rounded-full bg-emerald-500 px-3.5 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400" @click="creating = !creating">
          <Icon name="plus" class="h-4 w-4" /> Novo usuário
        </button>
      </header>

      <p v-if="loadError" class="text-sm text-rose-300">{{ loadError }}</p>
      <p v-if="resetDone" class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">{{ resetDone }}</p>

      <form v-if="creating" class="grid gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 sm:grid-cols-2" @submit.prevent="create">
        <label class="field">Nome<input v-model="form.name" required class="input" /><small v-for="m in formIssues.name" :key="m" class="error">{{ m }}</small></label>
        <label class="field">E-mail<input v-model="form.email" type="email" required class="input" /><small v-for="m in formIssues.email" :key="m" class="error">{{ m }}</small></label>
        <label class="field">
          Senha inicial
          <input v-model="form.password" type="password" required autocomplete="new-password" class="input" />
          <small class="text-xs font-normal text-zinc-500">Pelo menos 10 caracteres. A pessoa troca depois em Configuração.</small>
          <small v-for="m in formIssues.password" :key="m" class="error">{{ m }}</small>
        </label>
        <label class="field">
          Papel
          <select v-model="form.role" class="input">
            <option value="member">Membro — conversa com os agentes</option>
            <option value="admin">Administrador — agentes, usuários e configuração</option>
          </select>
        </label>
        <p v-if="formError" class="text-sm text-rose-300 sm:col-span-2">{{ formError }}</p>
        <div class="flex gap-2 sm:col-span-2">
          <button type="submit" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">Criar</button>
          <button type="button" class="rounded-full px-4 py-2 text-sm hover:bg-zinc-800" @click="creating = false">Cancelar</button>
        </div>
      </form>

      <ul class="divide-y divide-zinc-800 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
        <li v-for="user in users.list" :key="user.id" class="flex flex-wrap items-center gap-3 px-4 py-3" :class="{ 'opacity-60': user.disabled }">
          <div class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold" :class="user.role === 'admin' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-300'">{{ initials(user.name) }}</div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate font-medium">{{ user.name }}</span>
              <span v-if="user.id === auth.user?.id" class="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">você</span>
              <span v-if="user.disabled" class="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] text-rose-300">desativada</span>
            </div>
            <div class="truncate text-xs text-zinc-500">{{ user.email }} · {{ user.lastLoginAt ? `último acesso ${fullTime(user.lastLoginAt)}` : 'nunca entrou' }}</div>
            <p v-if="rowError[user.id]" class="mt-1 text-xs text-rose-300">{{ rowError[user.id] }}</p>
          </div>

          <label class="flex cursor-pointer items-center gap-2 text-xs text-zinc-400" :title="user.role === 'admin' && activeAdmins <= 1 && !user.disabled ? 'Último administrador ativo' : ''">
            Admin
            <button type="button" role="switch" :aria-checked="user.role === 'admin'" class="switch" :class="{ on: user.role === 'admin' }" @click="askRole(user)"><span /></button>
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
            Ativa
            <button type="button" role="switch" :aria-checked="!user.disabled" :disabled="user.id === auth.user?.id" class="switch disabled:cursor-not-allowed disabled:opacity-40" :class="{ on: !user.disabled }" @click="askDisabled(user)"><span /></button>
          </label>
          <button type="button" class="rounded-full px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800" @click="(resetting = user), (resetPassword = ''), (resetError = undefined), (resetDone = undefined)">Redefinir senha</button>
        </li>
      </ul>
    </div>

    <ConfirmDialog :open="!!pending" :title="pending?.title ?? ''" :message="pending?.message" :action="pending?.action" :busy="applying" @confirm="apply" @cancel="pending = undefined" />

    <Teleport to="body">
      <div v-if="resetting" class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" @click.self="resetting = undefined">
        <form class="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-5" @submit.prevent="doReset">
          <h2 class="font-semibold">Nova senha para {{ resetting.name }}</h2>
          <input v-model="resetPassword" type="password" required autocomplete="new-password" class="input mt-3 w-full" placeholder="Pelo menos 10 caracteres" />
          <p v-if="resetError" class="mt-2 text-xs text-rose-300">{{ resetError }}</p>
          <div class="mt-4 flex justify-end gap-2">
            <button type="button" class="rounded-full px-4 py-2 text-sm hover:bg-zinc-800" @click="resetting = undefined">Cancelar</button>
            <button type="submit" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950">Redefinir</button>
          </div>
        </form>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex flex-col gap-1.5 text-sm font-medium text-zinc-300;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
.error {
  @apply text-xs font-normal text-rose-300;
}
.switch {
  @apply relative h-6 w-11 rounded-full bg-zinc-700 transition-colors;
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
