<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import { ApiError } from '@/lib/api'
import { fullTime, initials } from '@/lib/format'
import type { IMcpServer, TMcpAuth, TMcpTransport } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useMcpStore, type INewMcpServer } from '@/stores/mcp'

/**
 * A guia MCPs: os servidores de onde os agentes tiram ferramentas. Cada agente escolhe, no formulário
 * dele, quais servidores e ferramentas usa.
 */
const props = defineProps<{ id?: string }>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const mcp = useMcpStore()

const AUTH_LABEL: Record<TMcpAuth, { label: string; hint: string }> = {
  caller: { label: 'Credencial de quem conversa', hint: 'O gateway repassa o token da pessoa (Authorization: Bearer …): o MCP decide o que cada uma vê.' },
  header: { label: 'Header fixo (segredo)', hint: 'Uma chave do serviço, guardada cifrada. Vale para todo mundo que conversa com o agente.' },
  none: { label: 'Nenhuma', hint: 'MCP aberto, sem credencial.' },
}
const TRANSPORT_LABEL: Record<TMcpTransport, string> = { auto: 'Automático', http: 'Streamable HTTP', sse: 'SSE' }

const adding = computed(() => route.name === 'mcp-new')
const selected = computed(() => (props.id ? mcp.list.find((server) => server.id === props.id) : undefined))

const loadError = ref<string>()
const blank = (): INewMcpServer => ({ id: '', name: '', url: '', transport: 'auto', auth: 'caller', headerName: 'Authorization', secret: '' })
const form = ref<INewMcpServer>(blank())
const formIssues = ref<Record<string, string[]>>({})
const formError = ref<string>()

const edit = ref<{ name: string; url: string; transport: TMcpTransport; auth: TMcpAuth; headerName: string }>()
const editError = ref<string>()
const secret = ref('')
const busy = ref(false)
const testResult = ref<{ ok: boolean; tools: number; message?: string }>()
const removing = ref<IMcpServer>()
const removeError = ref<string>()

onMounted(async () => {
  if (auth.isAdmin) await mcp.load().catch((error) => (loadError.value = describe(error)))
})

// Ao abrir um servidor: o formulário de edição com o que está gravado, e as ferramentas dele.
watch(
  selected,
  (server, previous) => {
    if (!server) return (edit.value = undefined)
    if (server.id !== previous?.id) {
      testResult.value = undefined
      secret.value = ''
      void mcp.loadTools(server.id).catch(() => undefined)
    }
    edit.value = { name: server.name, url: server.url, transport: server.transport, auth: server.auth, headerName: server.headerName ?? 'Authorization' }
  },
  { immediate: true },
)

const dirty = computed(() => {
  const server = selected.value
  const draft = edit.value
  if (!server || !draft) return false
  return draft.name !== server.name || draft.url !== server.url || draft.transport !== server.transport || draft.auth !== server.auth || (draft.auth === 'header' && draft.headerName !== (server.headerName ?? 'Authorization'))
})
const tools = computed(() => (selected.value ? (mcp.tools[selected.value.id] ?? []) : []))
const pointsToSelf = (url: string) => /\/v1\/mcp\/?$/.test(url.trim())

function describe(error: unknown): string {
  if (error instanceof ApiError && error.status === 422) return Object.values(error.fieldIssues).flat().join('; ') || error.message
  if (error instanceof ApiError && error.code === 'mcp_server_in_use') return `${error.message}. Tire o servidor desses agentes antes.`
  return error instanceof Error ? error.message : String(error)
}

function slug() {
  if (form.value.id) return
  form.value.id = form.value.name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
}

async function create() {
  formIssues.value = {}
  formError.value = undefined
  try {
    const { secret: value, headerName, ...rest } = form.value
    const created = await mcp.create({ ...rest, ...(rest.auth === 'header' ? { headerName, secret: value?.trim() || undefined } : {}) })
    form.value = blank()
    await router.push(`/mcp/${created.id}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) formIssues.value = error.fieldIssues
    formError.value = describe(error)
  }
}

async function run(work: () => Promise<void>) {
  busy.value = true
  editError.value = undefined
  try {
    await work()
  } catch (error) {
    editError.value = describe(error)
  } finally {
    busy.value = false
  }
}

const save = () => run(async () => mcp.update(selected.value!.id, { ...edit.value!, headerName: edit.value!.auth === 'header' ? edit.value!.headerName : undefined }))
const toggle = () => run(async () => mcp.update(selected.value!.id, { enabled: !selected.value!.enabled }))
const saveSecret = () =>
  run(async () => {
    await mcp.saveSecret(selected.value!.id, secret.value)
    secret.value = ''
  })
const clearSecret = () => run(async () => mcp.clearSecret(selected.value!.id))
const test = () =>
  run(async () => {
    testResult.value = await mcp.test(selected.value!.id)
  })

async function confirmRemove() {
  const target = removing.value
  if (!target) return
  removeError.value = undefined
  try {
    await mcp.remove(target.id)
    removing.value = undefined
    await router.push('/mcp')
  } catch (error) {
    removeError.value = describe(error)
  }
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <div>
      <p class="font-medium text-zinc-200">Só quem administra cadastra os MCPs.</p>
      <RouterLink v-if="!auth.signedIn && auth.localAccounts" :to="{ path: '/login', query: { next: '/mcp' } }" class="mt-3 inline-block rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950">Entrar</RouterLink>
    </div>
  </div>

  <MasterDetail v-else :open="!!id || adding" back-to="/mcp" back-label="MCPs" :title="adding ? 'Novo MCP' : selected?.name">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-1">
        <h1 class="text-xl font-semibold">MCPs</h1>
        <RouterLink to="/mcp/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Adicionar MCP"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <p class="px-4 pb-3 text-xs text-zinc-500">Os servidores de onde os agentes tiram ferramentas. Cada agente escolhe, no formulário dele, os servidores e as ferramentas que usa.</p>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <p v-if="!mcp.list.length && !loadError" class="px-4 py-2 text-sm text-zinc-500">Nenhum MCP cadastrado ainda.</p>
      <RouterLink
        v-for="server in mcp.list"
        :key="server.id"
        :to="`/mcp/${server.id}`"
        class="mx-2 flex items-center gap-3 rounded-xl px-3 py-2"
        :class="[server.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60', { 'opacity-60': !server.enabled }]"
      >
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-500/20 text-xs font-semibold text-violet-200">{{ initials(server.name) }}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ server.name }}</span>
          <span class="block truncate text-xs text-zinc-500">{{ server.enabled ? (server.status.connected ? 'conectado' : 'sem conexão') : 'desligado' }} · {{ server.agents.length }} agente(s)</span>
        </span>
        <span class="h-2 w-2 shrink-0 rounded-full" :class="server.enabled && server.status.connected ? 'bg-emerald-400' : 'bg-zinc-600'" />
      </RouterLink>
    </template>

    <template #detail>
      <template v-if="adding">
        <h2 class="mx-auto mb-4 max-w-3xl text-lg font-semibold">Novo MCP</h2>
        <form class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="create">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">Nome<input v-model="form.name" required class="input" placeholder="CRM interno" @blur="slug" /><small v-for="m in formIssues.name" :key="m" class="error">{{ m }}</small></label>
            <label class="field">
              Id
              <input v-model="form.id" required pattern="[a-z0-9][a-z0-9-]{1,31}" class="input font-mono" placeholder="crm" />
              <small class="hint">Os agentes escolhem as ferramentas como <code>mcp:{{ form.id || 'id' }}/…</code>. Não muda depois.</small>
              <small v-for="m in formIssues.id" :key="m" class="error">{{ m }}</small>
            </label>
            <label class="field sm:col-span-2">
              URL
              <input v-model="form.url" required class="input font-mono" placeholder="https://mcp.exemplo.com/mcp" />
              <small v-for="m in formIssues.url" :key="m" class="error">{{ m }}</small>
              <small v-if="pointsToSelf(form.url)" class="text-amber-300">⚠ É o MCP do próprio gateway: um agente que conversa com outros agentes pode entrar em recursão.</small>
            </label>
          </div>
          <div class="field">
            Transporte
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(label, value) in TRANSPORT_LABEL" :key="value" type="button" class="chip" :class="{ on: form.transport === value }" @click="form.transport = value">{{ label }}</button>
            </div>
          </div>
          <div class="field">
            Autenticação
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(option, value) in AUTH_LABEL" :key="value" type="button" class="chip" :class="{ on: form.auth === value }" @click="form.auth = value">{{ option.label }}</button>
            </div>
            <small class="hint">{{ AUTH_LABEL[form.auth].hint }}</small>
          </div>
          <div v-if="form.auth === 'header'" class="grid gap-3 sm:grid-cols-2">
            <label class="field">Header<input v-model="form.headerName" class="input font-mono" placeholder="Authorization" /></label>
            <label class="field">Valor (segredo)<input v-model="form.secret" type="password" autocomplete="off" spellcheck="false" class="input font-mono" placeholder="Bearer …" /></label>
          </div>
          <p v-if="formError && !Object.keys(formIssues).length" class="text-sm text-rose-300">{{ formError }}</p>
          <div class="flex gap-2">
            <button type="submit" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">Adicionar</button>
            <RouterLink to="/mcp" class="rounded-full px-4 py-2 text-sm hover:bg-zinc-800">Cancelar</RouterLink>
          </div>
        </form>
      </template>

      <section v-else-if="selected && edit" :key="selected.id" class="mx-auto flex max-w-3xl flex-col gap-4">
        <div class="flex items-center gap-3">
          <span class="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-violet-500/20 text-base font-semibold text-violet-200">{{ initials(selected.name) }}</span>
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold">{{ selected.name }}</h2>
            <p class="truncate font-mono text-xs text-zinc-500">mcp:{{ selected.id }}/…</p>
          </div>
          <label class="ml-auto flex shrink-0 items-center gap-2 text-xs text-zinc-400">
            Ligado
            <button type="button" role="switch" :aria-checked="selected.enabled" class="switch" :class="{ on: selected.enabled }" :disabled="busy" @click="toggle"><span /></button>
          </label>
        </div>

        <p v-if="selected.selfReference" class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          É o MCP do próprio gateway: um agente com estas ferramentas pode abrir conversas com outros agentes — inclusive com ele mesmo. Dê só as ferramentas de que ele precisa.
        </p>

        <form class="flex flex-col gap-3" @submit.prevent="save">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">Nome<input v-model="edit.name" required class="input" /></label>
            <label class="field">URL<input v-model="edit.url" required class="input font-mono" /></label>
          </div>
          <div class="field">
            Transporte
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(label, value) in TRANSPORT_LABEL" :key="value" type="button" class="chip" :class="{ on: edit.transport === value }" @click="edit.transport = value">{{ label }}</button>
            </div>
          </div>
          <div class="field">
            Autenticação
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(option, value) in AUTH_LABEL" :key="value" type="button" class="chip" :class="{ on: edit.auth === value }" @click="edit.auth = value">{{ option.label }}</button>
            </div>
            <small class="hint">{{ AUTH_LABEL[edit.auth].hint }}</small>
          </div>
          <label v-if="edit.auth === 'header'" class="field sm:w-1/2">Header<input v-model="edit.headerName" class="input font-mono" /></label>
          <div v-if="dirty" class="flex gap-2">
            <button type="submit" :disabled="busy" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">Salvar alterações</button>
          </div>
        </form>

        <div v-if="selected.auth === 'header'" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
          <p class="text-xs" :class="selected.secret.configured ? 'text-zinc-400' : 'text-amber-300'">
            <template v-if="selected.secret.configured">Segredo salvo · termina em …{{ selected.secret.last4 }}<template v-if="selected.secret.updatedAt"> · {{ fullTime(selected.secret.updatedAt) }}</template></template>
            <template v-else>Sem segredo: o header não é enviado.</template>
          </p>
          <form class="flex flex-wrap items-center gap-2" @submit.prevent="saveSecret">
            <input v-model="secret" type="password" autocomplete="off" spellcheck="false" :placeholder="selected.secret.configured ? 'Colar novo valor para trocar' : `Valor do ${selected.headerName ?? 'Authorization'}`" class="input min-w-0 flex-1 font-mono text-sm" />
            <button type="submit" :disabled="busy || !secret.trim()" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">Salvar</button>
            <button v-if="selected.secret.configured" type="button" class="rounded-full px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10" @click="clearSecret">Remover</button>
          </form>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <button type="button" :disabled="busy || !selected.enabled" class="rounded-full bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-40" @click="test">Testar conexão</button>
          <span v-if="testResult" class="text-sm" :class="testResult.ok ? 'text-emerald-300' : 'text-rose-300'">{{ testResult.ok ? `✓ Conectado — ${testResult.tools} ferramenta(s).` : `✕ ${testResult.message}` }}</span>
          <span v-else-if="selected.status.lastError" class="text-xs text-rose-300">Último erro: {{ selected.status.lastError }}</span>
        </div>
        <p v-if="editError" class="text-sm text-rose-300">{{ editError }}</p>

        <div class="border-t border-zinc-800/80 pt-4">
          <h3 class="mb-2 text-sm font-medium text-zinc-200">Ferramentas <span class="text-xs font-normal text-zinc-500">{{ tools.length }}</span></h3>
          <ul v-if="tools.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
            <li v-for="tool in tools" :key="tool.name" class="px-3 py-2">
              <div class="font-mono text-[13px] text-zinc-200">{{ tool.name }}</div>
              <div v-if="tool.description" class="text-xs text-zinc-500">{{ tool.description }}</div>
            </li>
          </ul>
          <p v-else class="text-xs text-zinc-500">{{ selected.enabled ? 'Nenhuma ferramenta listada (servidor fora do ar, ou sem ferramentas).' : 'Ligue o servidor para listar as ferramentas.' }}</p>
        </div>

        <div class="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          <span>Agentes:</span>
          <RouterLink v-for="agent in selected.agents" :key="agent.id" :to="`/agents/${agent.id}`" class="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300 hover:bg-zinc-700">{{ agent.name }}</RouterLink>
          <span v-if="!selected.agents.length">nenhum ainda — escolha as ferramentas no formulário do agente</span>
          <button type="button" class="ml-auto text-rose-300 hover:underline" @click="(removing = selected), (removeError = undefined)">Remover MCP</button>
        </div>
      </section>
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um MCP ou adicione um novo.</div>

      <ConfirmDialog
        :open="!!removing"
        :title="`Remover o MCP ${removing?.name ?? ''}?`"
        :message="removeError ?? 'O servidor e o segredo dele somem. Se algum agente ainda o usa, o gateway recusa e diz quais.'"
        action="Remover"
        @confirm="confirmRemove"
        @cancel="removing = undefined"
      />
    </template>
  </MasterDetail>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex min-w-0 flex-col gap-1.5 text-sm font-medium text-zinc-300;
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
