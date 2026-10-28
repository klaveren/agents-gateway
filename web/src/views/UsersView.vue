<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import { ApiError } from '@/lib/api'
import { fullTime, initials } from '@/lib/format'
import type { IUser, TUserRole } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useUsersStore } from '@/stores/users'

const props = defineProps<{ id?: string }>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const users = useUsersStore()

/** `/users/new` abre o formulário no lugar do detalhe. */
const creating = computed(() => route.name === 'user-new')
const selected = computed(() => (props.id ? users.list.find((user) => user.id === props.id) : undefined))

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

const form = ref({ name: '', email: '', password: '', role: 'member' as TUserRole })
const formIssues = ref<Record<string, string[]>>({})
const formError = ref<string>()

const resetting = ref<IUser>()
const resetPassword = ref('')
const resetError = ref<string>()
const resetDone = ref<string>()

const ending = ref<IUser>()
const endingBusy = ref(false)

/** ⚠️ Todos os problemas de um 422, com o campo — inclusive de campos que não têm input na tela (senão sumiriam). */
function issuesSummary(error: ApiError): string {
  const items = Array.isArray(error.details) ? (error.details as Array<{ field?: string; message?: string }>) : []
  const lines = items.map((item) => (item.field ? `${item.field}: ${item.message ?? 'inválido'}` : (item.message ?? 'inválido')))
  return lines.join('; ') || error.message
}

const errorText = (error: unknown): string => (error instanceof ApiError && error.status === 422 ? issuesSummary(error) : error instanceof Error ? error.message : String(error))

async function endSessions() {
  const target = ending.value
  if (!target) return
  endingBusy.value = true
  rowError.value = {}
  try {
    await users.revokeSessions(target.id)
    resetDone.value = `Sessões de ${target.name} encerradas. Ela precisa entrar de novo em todos os aparelhos.`
    ending.value = undefined
    // A própria conta: a sessão deste navegador também caiu.
    if (target.id === auth.user?.id) await auth.probe()
  } catch (error) {
    // Falhou: o aviso de sucesso não pode ficar, e o erro aparece na conta (o diálogo fecha).
    resetDone.value = undefined
    rowError.value = { ...rowError.value, [target.id]: `Não foi possível encerrar as sessões: ${errorText(error)}` }
    ending.value = undefined
  } finally {
    endingBusy.value = false
  }
}

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
    title: toAdmin ? `Tornar ${user.name} administrador?` : `Tirar o administrador de ${user.name}?`,
    message: toAdmin
      ? 'Administrador cria agentes, vê todas as conversas e muda a configuração.'
      : 'Ele sai agora e volta como membro.',
    action: toAdmin ? 'Tornar administrador' : 'Tirar administrador',
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
    rowError.value = { ...rowError.value, [current.user.id]: translate(errorText(error)) }
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
    const created = await users.create(form.value)
    rowError.value = {}
    form.value = { name: '', email: '', password: '', role: 'member' }
    await router.push(`/users/${created.id}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) formIssues.value = error.fieldIssues
    // O resumo vem sempre: campo sem input na tela (papel, por ex.) não teria onde mostrar a mensagem.
    formError.value = errorText(error)
  }
}

async function doReset() {
  if (!resetting.value) return
  resetError.value = undefined
  try {
    await users.resetPassword(resetting.value.id, resetPassword.value)
    resetDone.value = `Senha de ${resetting.value.name} redefinida e sessões dela encerradas. Passe a nova senha por um canal seguro.`
    resetting.value = undefined
    resetPassword.value = ''
  } catch (error) {
    resetError.value = errorText(error)
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

  <MasterDetail v-else :open="!!id || creating" back-to="/users" back-label="Usuários" :title="creating ? 'Novo usuário' : selected?.name">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-3">
        <h1 class="text-xl font-semibold">Usuários</h1>
        <span class="text-sm text-zinc-500">{{ users.list.length }}</span>
        <RouterLink to="/users/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Novo usuário"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <RouterLink
        v-for="user in users.list"
        :key="user.id"
        :to="`/users/${user.id}`"
        class="mx-2 flex items-center gap-3 rounded-xl px-3 py-2"
        :class="[user.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60', { 'opacity-60': user.disabled }]"
      >
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold" :class="user.role === 'admin' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-300'">{{ initials(user.name) }}</span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5">
            <span class="truncate text-sm font-medium">{{ user.name }}</span>
            <span v-if="user.id === auth.user?.id" class="shrink-0 rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">você</span>
          </span>
          <span class="block truncate text-xs text-zinc-500">{{ user.role === 'admin' ? 'administrador' : 'membro' }}{{ user.disabled ? ' · desativada' : '' }} · {{ user.email }}</span>
        </span>
      </RouterLink>
    </template>

    <template #detail>
      <p v-if="resetDone" class="mx-auto mb-4 max-w-3xl rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">{{ resetDone }}</p>

      <template v-if="creating">
        <h2 class="mx-auto mb-4 max-w-3xl text-lg font-semibold">Novo usuário</h2>
        <form class="mx-auto grid max-w-3xl gap-3 sm:grid-cols-2" @submit.prevent="create">
          <label class="field">Nome<input v-model="form.name" required class="input" /><small v-for="m in formIssues.name" :key="m" class="error">{{ m }}</small></label>
          <label class="field">E-mail<input v-model="form.email" type="email" required class="input" /><small v-for="m in formIssues.email" :key="m" class="error">{{ m }}</small></label>
          <label class="field">
            Senha inicial
            <input v-model="form.password" type="password" required autocomplete="new-password" class="input" />
            <small class="text-xs font-normal text-zinc-500">Pelo menos 10 caracteres. A pessoa troca depois em Perfil.</small>
            <small v-for="m in formIssues.password" :key="m" class="error">{{ m }}</small>
          </label>
          <label class="field">
            Papel
            <select v-model="form.role" class="input w-full min-w-0">
              <option value="member">Membro — conversa com os agentes</option>
              <option value="admin">Administrador — agentes, usuários e configuração</option>
            </select>
          </label>
          <p v-if="formError" class="text-sm text-rose-300 sm:col-span-2">{{ formError }}</p>
          <div class="flex gap-2 sm:col-span-2">
            <button type="submit" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">Criar</button>
            <RouterLink to="/users" class="rounded-full px-4 py-2 text-sm hover:bg-zinc-800">Cancelar</RouterLink>
          </div>
        </form>
      </template>

      <section v-else-if="selected" :key="selected.id" class="mx-auto flex max-w-3xl flex-col gap-4" :class="{ 'opacity-80': selected.disabled }">
        <div class="flex items-center gap-3">
          <span class="grid h-14 w-14 shrink-0 place-items-center rounded-full text-base font-semibold" :class="selected.role === 'admin' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-300'">{{ initials(selected.name) }}</span>
          <div class="min-w-0">
            <h2 class="flex flex-wrap items-center gap-2 text-lg font-semibold">
              <span class="truncate">{{ selected.name }}</span>
              <span v-if="selected.id === auth.user?.id" class="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-normal text-zinc-400">você</span>
              <span v-if="selected.disabled" class="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-normal text-rose-300">desativada</span>
            </h2>
            <p class="text-xs break-words text-zinc-500">{{ selected.email }} · {{ selected.lastLoginAt ? `último acesso ${fullTime(selected.lastLoginAt)}` : 'nunca entrou' }}</p>
          </div>
        </div>
        <p v-if="rowError[selected.id]" class="text-sm text-rose-300">{{ rowError[selected.id] }}</p>

        <div class="divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900/40">
          <label class="flex cursor-pointer items-center gap-3 px-4 py-3" :title="selected.role === 'admin' && activeAdmins <= 1 && !selected.disabled ? 'Último administrador ativo' : ''">
            <span class="min-w-0 flex-1">
              <span class="block text-sm text-zinc-200">Administrador</span>
              <span class="block text-xs text-zinc-500">Cria e edita agentes, vê todas as conversas e muda a configuração.</span>
            </span>
            <button type="button" role="switch" :aria-checked="selected.role === 'admin'" class="switch shrink-0" :class="{ on: selected.role === 'admin' }" @click="askRole(selected)"><span /></button>
          </label>
          <label class="flex cursor-pointer items-center gap-3 px-4 py-3">
            <span class="min-w-0 flex-1">
              <span class="block text-sm text-zinc-200">Conta ativa</span>
              <span class="block text-xs text-zinc-500">Desativada, a conta não consegue entrar.</span>
            </span>
            <button type="button" role="switch" :aria-checked="!selected.disabled" :disabled="selected.id === auth.user?.id" class="switch shrink-0 disabled:cursor-not-allowed disabled:opacity-40" :class="{ on: !selected.disabled }" @click="askDisabled(selected)"><span /></button>
          </label>
        </div>

        <div class="flex flex-wrap gap-2">
          <button type="button" class="rounded-full bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700" @click="(resetting = selected), (resetPassword = ''), (resetError = undefined), (resetDone = undefined)">Redefinir senha</button>
          <button type="button" class="rounded-full bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700" @click="(ending = selected), (resetDone = undefined)">Encerrar sessões</button>
          <RouterLink v-if="auth.isAdmin" :to="{ path: '/usage', query: { tab: 'users', user: selected.id } }" class="rounded-full px-3 py-1.5 text-sm text-emerald-400 hover:bg-zinc-800">Ver uso →</RouterLink>
        </div>
      </section>
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um usuário ou crie um novo.</div>

      <ConfirmDialog
        :open="!!ending"
        :title="`Encerrar as sessões de ${ending?.name ?? ''}?`"
        :message="ending?.id === auth.user?.id ? 'Inclui a sua sessão neste navegador: você vai precisar entrar de novo.' : 'A pessoa sai de todos os aparelhos. A senha não muda.'"
        action="Encerrar"
        :busy="endingBusy"
        @confirm="endSessions"
        @cancel="ending = undefined"
      />
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
