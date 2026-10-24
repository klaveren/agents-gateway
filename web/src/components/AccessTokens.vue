<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, ApiError } from '@/lib/api'
import { fullTime } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import ConfirmDialog from './ConfirmDialog.vue'
import Icon from './Icon.vue'

interface IAccessToken {
  id: string
  name: string
  prefix: string
  createdAt: string
  expiresAt?: string
  lastUsedAt?: string
  revokedAt?: string
}

/**
 * Os tokens de acesso pessoais: para o Claude Code (MCP), scripts e integrações.
 *
 * ⛔ O token aparece UMA vez, logo depois de criado, e some da tela ao fechar o aviso — o servidor guarda só
 * o hash e não o devolve de novo.
 */
const auth = useAuthStore()
const tokens = ref<IAccessToken[]>([])
const loadError = ref<string>()
const name = ref('Claude Code')
const days = ref<number | ''>(90)
const creating = ref(false)
const createError = ref<string>()
const revealed = ref<{ name: string; token: string }>()
const copied = ref<string>()
const revoking = ref<IAccessToken>()

const DAYS = [
  { value: 30, label: '30 dias' },
  { value: 90, label: '90 dias' },
  { value: 365, label: '1 ano' },
  { value: '', label: 'Sem validade' },
] as const

/** Ativo = não revogado E dentro da validade: token vencido não vale e não conta nos 20. */
const isActive = (token: IAccessToken) => !token.revokedAt && (!token.expiresAt || new Date(token.expiresAt).getTime() > Date.now())
const active = computed(() => tokens.value.filter(isActive))
const mcpCommand = computed(() =>
  revealed.value
    ? `claude mcp add --transport http gateway ${location.origin}/v1/mcp --header "X-Tool-Authorization: Bearer ${revealed.value.token}"${auth.gatewayToken ? ' --header "Authorization: Bearer <GATEWAY_TOKEN>"' : ''}`
    : '',
)

async function load() {
  try {
    tokens.value = await api<IAccessToken[]>('/auth/tokens')
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  }
}
onMounted(load)

async function create() {
  creating.value = true
  createError.value = undefined
  try {
    const created = await api<IAccessToken & { token: string }>('/auth/tokens', { method: 'POST', body: { name: name.value, ...(days.value ? { expiresInDays: days.value } : {}) } })
    revealed.value = { name: created.name, token: created.token }
    await load()
  } catch (error) {
    createError.value = error instanceof ApiError && error.status === 422 ? Object.values(error.fieldIssues).flat().join('; ') : error instanceof Error ? error.message : String(error)
  } finally {
    creating.value = false
  }
}

async function copy(label: string, value: string) {
  await navigator.clipboard.writeText(value).catch(() => undefined)
  copied.value = label
  setTimeout(() => (copied.value = undefined), 1500)
}

async function revoke() {
  const target = revoking.value
  if (!target) return
  await api(`/auth/tokens/${encodeURIComponent(target.id)}`, { method: 'DELETE' }).catch((error) => (loadError.value = error instanceof Error ? error.message : String(error)))
  revoking.value = undefined
  await load()
}
</script>

<template>
  <section id="tokens" class="flex scroll-mt-4 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
    <h2 class="font-medium">Tokens de acesso</h2>
    <p class="text-xs text-zinc-400">
      Para o Claude Code (MCP do gateway), scripts e integrações. O token age como a sua conta — perdeu o admin, o token perde junto — e não cai ao sair. Revogue aqui quando não usar mais.
    </p>

    <div v-if="revealed" class="flex flex-col gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
      <p class="text-emerald-200">Token <strong>{{ revealed.name }}</strong> criado. Copie agora: ele não aparece de novo.</p>
      <div class="flex min-w-0 items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded-lg bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100">{{ revealed.token }}</code>
        <button class="flex shrink-0 items-center gap-1 rounded-full bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700" @click="copy('token', revealed.token)"><Icon :name="copied === 'token' ? 'check' : 'copy'" class="h-3.5 w-3.5" /> Copiar</button>
      </div>
      <p class="text-xs text-zinc-400">Para ligar no Claude Code:</p>
      <div class="flex min-w-0 items-start gap-2">
        <code class="min-w-0 flex-1 rounded-lg bg-zinc-950 px-2 py-1.5 font-mono text-[11px] break-all text-zinc-300">{{ mcpCommand }}</code>
        <button class="flex shrink-0 items-center gap-1 rounded-full bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700" @click="copy('cmd', mcpCommand)"><Icon :name="copied === 'cmd' ? 'check' : 'copy'" class="h-3.5 w-3.5" /> Copiar</button>
      </div>
      <button class="self-start text-xs text-zinc-400 hover:text-zinc-100" @click="revealed = undefined">Já copiei — fechar</button>
    </div>

    <form class="flex flex-wrap items-end gap-2" @submit.prevent="create">
      <label class="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-sm text-zinc-300">
        Nome
        <input v-model="name" required maxlength="60" class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm" placeholder="Claude Code" />
      </label>
      <label class="flex flex-col gap-1 text-sm text-zinc-300">
        Validade
        <select v-model="days" class="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2 text-sm">
          <option v-for="option in DAYS" :key="option.label" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <button type="submit" :disabled="creating" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">Criar token</button>
    </form>
    <p v-if="createError" class="text-sm text-rose-300">{{ createError }}</p>
    <p v-if="loadError" class="text-sm text-rose-300">{{ loadError }}</p>

    <ul v-if="tokens.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
      <li v-for="token in tokens" :key="token.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" :class="{ 'opacity-50': !isActive(token) }">
        <div class="min-w-0 flex-1 basis-48">
          <div class="flex items-center gap-2">
            <span class="truncate text-sm font-medium">{{ token.name }}</span>
            <code class="shrink-0 text-[11px] text-zinc-500">{{ token.prefix }}…</code>
          </div>
          <div class="text-xs text-zinc-500">
            criado {{ fullTime(token.createdAt) }} ·
            {{ token.lastUsedAt ? `usado ${fullTime(token.lastUsedAt)}` : 'nunca usado' }} ·
            <template v-if="token.revokedAt">revogado {{ fullTime(token.revokedAt) }}</template>
            <template v-else-if="!isActive(token)">venceu {{ fullTime(token.expiresAt!) }}</template>
            <template v-else>{{ token.expiresAt ? `vale até ${fullTime(token.expiresAt)}` : 'sem validade' }}</template>
          </div>
        </div>
        <button v-if="!token.revokedAt" class="rounded-full px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/10" @click="revoking = token">Revogar</button>
      </li>
    </ul>
    <p v-else class="text-xs text-zinc-500">Nenhum token ainda.</p>
    <p v-if="active.length" class="text-xs text-zinc-500">{{ active.length }} ativo(s) de no máximo 20.</p>

    <ConfirmDialog
      :open="!!revoking"
      :title="`Revogar o token ${revoking?.name ?? ''}?`"
      message="Quem usa este token (o Claude Code, um script) perde o acesso na hora. Não dá para desfazer: crie outro se precisar."
      action="Revogar"
      @confirm="revoke"
      @cancel="revoking = undefined"
    />
  </section>
</template>
