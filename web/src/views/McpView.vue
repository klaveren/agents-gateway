<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import MasterDetail from '@/components/MasterDetail.vue'
import McpContainerFields from '@/components/McpContainerFields.vue'
import McpProcessFields from '@/components/McpProcessFields.vue'
import { ApiError } from '@/lib/api'
import { fullTime, initials } from '@/lib/format'
import { toolsTokens, toolTokens } from '@/lib/toolTokens'
import type { IMcpContainer, IMcpProcess, IMcpServer, TMcpAuth, TMcpKind, TMcpTransport } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useMcpStore, type INewMcpServer } from '@/stores/mcp'
import { useSettingsStore } from '@/stores/settings'

/**
 * A guia MCPs: os servidores de onde os agentes tiram ferramentas. Cada agente escolhe, no formulário
 * dele, quais servidores e ferramentas usa.
 */
const props = defineProps<{ id?: string }>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const mcp = useMcpStore()
const settings = useSettingsStore()
/** O MCP do próprio gateway: a URL e a credencial são do sistema, não se editam. */
const isSelf = computed(() => selected.value?.id === 'gateway')
/** Sem Docker neste servidor (o pod do k3s não tem): o "Contêiner isolado" não sobe. `undefined` = não se sabe. */
const dockerDown = computed(() => {
  const docker = settings.current?.deployment?.docker
  return docker && !docker.available ? (docker.reason ?? 'o Docker não responde') : undefined
})

const AUTH_LABEL: Record<TMcpAuth, { label: string; hint: string }> = {
  caller: { label: 'Login de quem conversa', hint: 'O MCP recebe o login da pessoa e decide o que ela vê.' },
  header: { label: 'Chave fixa', hint: 'Uma chave só, usada por todos que falam com o agente.' },
  none: { label: 'Nenhuma', hint: 'Sem autenticação.' },
}
const TRANSPORT_LABEL: Record<TMcpTransport, string> = { auto: 'Automático', http: 'Streamable HTTP', sse: 'SSE' }

const adding = computed(() => route.name === 'mcp-new')
const selected = computed(() => (props.id ? mcp.list.find((server) => server.id === props.id) : undefined))

const loadError = ref<string>()
const blankContainer = (): IMcpContainer => ({ image: '', args: [], writable: [], memoryMb: 1024, cpus: 1, network: 'none', allowedHosts: [], env: [] })
const blankProcess = (): IMcpProcess => ({ package: '', command: '', args: [], env: [], scope: 'conversation' })
const blank = (): INewMcpServer => ({ id: '', name: '', kind: 'process', container: blankContainer(), process: blankProcess(), url: '', transport: 'auto', auth: 'none', headerName: 'Authorization', secret: '' })
const KIND_LABEL: Record<TMcpKind, { label: string; hint: string }> = {
  process: { label: 'Local (npm)', hint: 'Instala o pacote npm e roda no servidor, sem isolamento.' },
  remote: { label: 'Remoto (URL)', hint: 'Um MCP que já está no ar, acessado por URL.' },
  container: { label: 'Contêiner isolado', hint: 'Roda isolado, um contêiner por conversa. Precisa de Docker.' },
}
/** O rascunho do contêiner na edição (a cópia do que está gravado). */
const containerDraft = ref<IMcpContainer>(blankContainer())
const processDraft = ref<IMcpProcess>(blankProcess())
const installResult = ref<{ ok: boolean; version?: string; log: string }>()
const installing = ref(false)
const envValues = ref<Record<string, string>>({})
const form = ref<INewMcpServer>(blank())
const formIssues = ref<Record<string, string[]>>({})
const formError = ref<string>()

interface IEdit {
  name: string
  url: string
  transport: TMcpTransport
  auth: TMcpAuth
  headerName: string
}
const edit = ref<IEdit>()
const editError = ref<string>()
const toolsError = ref<string>()
const secret = ref('')
const busy = ref(false)
const testResult = ref<{ ok: boolean; tools: number; message?: string }>()
const removing = ref<IMcpServer>()
const removeError = ref<string>()

onMounted(async () => {
  if (auth.isAdmin) await Promise.all([mcp.load().catch((error) => (loadError.value = describe(error))), settings.load().catch(() => undefined)])
})

const editOf = (server: IMcpServer): IEdit => ({ name: server.name, url: server.url, transport: server.transport, auth: server.auth, headerName: server.headerName ?? 'Authorization' })

// Ao abrir um servidor: o formulário de edição com o que está gravado, e as ferramentas dele.
watch(
  selected,
  (server, previous) => {
    if (!server) return (edit.value = undefined)
    const switched = server.id !== previous?.id
    if (switched) {
      testResult.value = undefined
      installResult.value = undefined
      editError.value = undefined
      toolsError.value = undefined
      // ⛔ Segredo digitado é de UM servidor: não pode aparecer no formulário de outro.
      secret.value = ''
      envValues.value = {}
      mcp.loadTools(server.id).catch((error) => (toolsError.value = describe(error)))
    }
    // ⚠️ "Testar" e "Ligado" recarregam a lista e o `selected` muda de objeto: a edição não salva só é
    // sobrescrita quando o servidor é outro ou quando o formulário ainda não tinha mudança.
    if (switched || !edit.value || JSON.stringify(edit.value) === JSON.stringify(editOf(previous!))) edit.value = editOf(server)
    if (server.container && switched) containerDraft.value = JSON.parse(JSON.stringify(server.container)) as IMcpContainer
    if (server.process && switched) processDraft.value = withProcessDefaults(server.process)
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
/** As mais pesadas primeiro: é por elas que vale começar a cortar. */
const toolsByWeight = computed(() => [...tools.value].sort((a, b) => toolTokens(b) - toolTokens(a)))
const pointsToSelf = (url: string) => /\/v1\/mcp\/?$/.test(url.trim())

/** ⚠️ Todos os problemas de um 422, com o campo — inclusive de campos que não têm input na tela (senão sumiriam). */
function issuesSummary(error: ApiError): string {
  const items = Array.isArray(error.details) ? (error.details as Array<{ field?: string; message?: string }>) : []
  const lines = items.map((item) => (item.field ? `${item.field}: ${item.message ?? 'inválido'}` : (item.message ?? 'inválido')))
  return lines.join('; ') || error.message
}

/** Os problemas de `container.*` por campo do contêiner (`container.image` → `image`): `fieldIssues` só guarda o 1º trecho. */
function containerIssuesOf(error: ApiError): Record<string, string[]> {
  const issues: Record<string, string[]> = {}
  for (const item of Array.isArray(error.details) ? (error.details as Array<{ field?: string; message?: string }>) : []) {
    const [head, field] = (item.field ?? '').split('.')
    if ((head === 'container' || head === 'process') && field) (issues[field] ??= []).push(item.message ?? 'inválido')
  }
  return issues
}

/** O processo como a tela edita (campos opcionais vazios em vez de ausentes) e como vai no corpo. */
const withProcessDefaults = (proc: IMcpProcess): IMcpProcess => ({ ...blankProcess(), ...(JSON.parse(JSON.stringify(proc)) as IMcpProcess) })
const processPayload = (proc: IMcpProcess): IMcpProcess => ({ ...proc, package: proc.package?.trim() ?? '', command: proc.command?.trim() ?? '' })

/** ⚠️ Com "Sem rede" o campo de domínios some da tela: o que sobrou digitado nele não vai no corpo. */
const containerPayload = (container: IMcpContainer): IMcpContainer => (container.network === 'none' ? { ...container, allowedHosts: [] } : container)

function describe(error: unknown): string {
  if (error instanceof ApiError && error.status === 422) return issuesSummary(error)
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
    const { secret: value, headerName, container, process: proc, ...rest } = form.value
    const created =
      rest.kind === 'container'
        ? await mcp.create({ id: rest.id, name: rest.name, kind: 'container', container: container && containerPayload(container), url: '', transport: 'auto', auth: 'none' })
        : rest.kind === 'process'
          ? await mcp.create({ id: rest.id, name: rest.name, kind: 'process', process: proc && processPayload(proc), url: '', transport: 'auto', auth: 'none' })
          : await mcp.create({ ...rest, ...(rest.auth === 'header' ? { headerName, secret: value?.trim() || undefined } : {}) })
    form.value = blank()
    await router.push(`/mcp/${created.id}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) formIssues.value = { ...error.fieldIssues, ...containerIssuesOf(error) }
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
const containerDirty = computed(() => !!selected.value?.container && JSON.stringify(selected.value.container) !== JSON.stringify(containerPayload(containerDraft.value)))
const saveContainer = () => run(async () => mcp.update(selected.value!.id, { name: edit.value!.name, container: containerPayload(containerDraft.value) }))
const processDirty = computed(() => !!selected.value?.process && JSON.stringify(processPayload(withProcessDefaults(selected.value.process))) !== JSON.stringify(processPayload(processDraft.value)))
const saveProcess = () => run(async () => mcp.update(selected.value!.id, { name: edit.value!.name, process: processPayload(processDraft.value) }))
const install = () =>
  run(async () => {
    installResult.value = undefined
    installing.value = true
    try {
      installResult.value = await mcp.install(selected.value!.id)
    } finally {
      installing.value = false
    }
  })
const saveEnv = (name: string) =>
  run(async () => {
    await mcp.saveEnv(selected.value!.id, name, envValues.value[name] ?? '')
    envValues.value = { ...envValues.value, [name]: '' }
  })
const stopAll = () =>
  run(async () => {
    await mcp.stop(selected.value!.id)
  })
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
      <RouterLink v-if="!auth.signedIn && auth.localAccounts" :to="{ path: '/login', query: { next: '/mcp' } }" class="mt-3 btn btn-primary">Entrar</RouterLink>
    </div>
  </div>

  <MasterDetail v-else :open="!!id || adding" back-to="/mcp" back-label="MCPs" :title="adding ? 'Novo MCP' : selected?.name">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-1">
        <h1 class="text-xl font-semibold">MCPs</h1>
        <RouterLink to="/mcp/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Adicionar MCP"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <p class="px-4 pb-3 text-xs text-zinc-500">Servidores que dão ferramentas aos agentes. Cada agente escolhe as que usa.</p>
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
          <span class="block truncate text-xs text-zinc-500">{{ !server.enabled ? 'desligado' : server.kind === 'container' ? `contêiner · ${server.status.instances ?? 0} ativa(s)` : server.kind === 'process' ? `local · ${server.status.instances ?? 0} ativa(s)` : server.status.connected ? 'conectado' : 'sem conexão' }} · {{ server.agents.length }} agente(s)</span>
        </span>
        <span class="h-2 w-2 shrink-0 rounded-full" :class="server.enabled && server.status.connected ? 'bg-emerald-400' : 'bg-zinc-600'" />
      </RouterLink>
    </template>

    <template #detail>
      <template v-if="adding">
        <h2 class="mx-auto mb-4 max-w-3xl text-lg font-semibold">Novo MCP</h2>
        <form class="mx-auto flex max-w-3xl flex-col gap-3" @submit.prevent="create">
          <div class="field">
            Tipo
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="(option, value) in KIND_LABEL"
                :key="value"
                type="button"
                class="chip disabled:cursor-not-allowed disabled:opacity-40"
                :class="{ on: form.kind === value }"
                :disabled="value === 'container' && !!dockerDown && form.kind !== 'container'"
                :title="value === 'container' && dockerDown ? `Indisponível: ${dockerDown}` : undefined"
                @click="form.kind = value"
              >
                {{ option.label }}
              </button>
            </div>
            <small class="hint">{{ KIND_LABEL[form.kind].hint }}</small>
            <small v-if="dockerDown" class="hint text-amber-300/80">Contêiner indisponível: {{ dockerDown }}. Use "Local (npm)".</small>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">Nome<input v-model="form.name" required class="input" placeholder="CRM interno" @blur="slug" /><small v-for="m in formIssues.name" :key="m" class="error">{{ m }}</small></label>
            <label class="field">
              Identificador
              <input v-model="form.id" required pattern="[a-z0-9][a-z0-9-]{1,31}" class="input font-mono" placeholder="crm" />
              <small class="hint">Nome interno usado nos agentes: <code>mcp:{{ form.id || 'id' }}/…</code>. Não muda depois.</small>
              <small v-for="m in formIssues.id" :key="m" class="error">{{ m }}</small>
            </label>
            <label v-if="form.kind === 'remote'" class="field sm:col-span-2">
              URL
              <input v-model="form.url" required class="input font-mono" placeholder="https://mcp.exemplo.com/mcp" />
              <small v-for="m in formIssues.url" :key="m" class="error">{{ m }}</small>
              <small v-if="pointsToSelf(form.url)" class="text-amber-300">⚠ Este é o MCP do próprio gateway: um agente pode acabar chamando a si mesmo.</small>
            </label>
          </div>
          <McpContainerFields v-if="form.kind === 'container' && form.container" v-model="form.container" :issues="formIssues" />
          <McpProcessFields v-if="form.kind === 'process' && form.process" v-model="form.process" :issues="formIssues" />
          <p v-if="form.kind === 'process'" class="text-xs text-zinc-500">Depois de adicionar, clique em <strong>Instalar</strong> para baixar o pacote.</p>
          <div v-if="form.kind === 'remote'" class="field">
            Conexão
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(label, value) in TRANSPORT_LABEL" :key="value" type="button" class="chip" :class="{ on: form.transport === value }" @click="form.transport = value">{{ label }}</button>
            </div>
          </div>
          <div v-if="form.kind === 'remote'" class="field">
            Autenticação
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(option, value) in AUTH_LABEL" :key="value" type="button" class="chip" :class="{ on: form.auth === value }" @click="form.auth = value">{{ option.label }}</button>
            </div>
            <small class="hint">{{ AUTH_LABEL[form.auth].hint }}</small>
            <small v-if="form.auth === 'caller'" class="text-xs text-amber-300">⚠ O servidor passa a agir como a pessoa que conversa. Só use em servidor seu, de confiança.</small>
          </div>
          <div v-if="form.kind === 'remote' && form.auth === 'header'" class="grid gap-3 sm:grid-cols-2">
            <label class="field">Cabeçalho<input v-model="form.headerName" class="input font-mono" placeholder="Authorization" /></label>
            <label class="field">Chave<input v-model="form.secret" type="password" autocomplete="off" spellcheck="false" class="input font-mono" placeholder="Bearer …" /></label>
          </div>
          <p v-if="formError" class="text-sm text-rose-300">{{ formError }}</p>
          <div class="flex gap-2">
            <button type="submit" class="btn btn-primary">Adicionar</button>
            <RouterLink to="/mcp" class="btn btn-ghost">Cancelar</RouterLink>
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
          MCP do próprio gateway: o agente pode abrir conversas com outros agentes, até com ele mesmo. Dê só o necessário.
        </p>

        <template v-if="selected.kind === 'container'">
          <p v-if="dockerDown" class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            Este MCP não roda neste servidor: {{ dockerDown }}. Recrie como "Local (npm)".
          </p>
          <div class="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300">contêiner isolado</span>
            <span>{{ selected.status.instances ?? 0 }} em execução — uma por conversa</span>
            <button v-if="selected.status.instances" type="button" class="ml-auto btn btn-sm btn-danger" :disabled="busy" @click="stopAll">Encerrar todas</button>
          </div>
          <label class="field">Nome<input v-model="edit.name" required class="input" /></label>
          <McpContainerFields v-model="containerDraft" />
          <div v-if="containerDirty || edit.name !== selected.name" class="flex gap-2">
            <button type="button" :disabled="busy" class="btn btn-primary" @click="saveContainer">Salvar alterações</button>
            <span class="self-center text-xs text-zinc-500">Vale para as próximas conversas.</span>
          </div>
          <div v-if="selected.env?.length" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
            <h3 class="text-sm font-medium text-zinc-200">Variáveis secretas</h3>
            <form v-for="variable in selected.env" :key="variable.name" class="flex flex-wrap items-center gap-2" @submit.prevent="saveEnv(variable.name)">
              <code class="w-40 shrink-0 text-xs text-zinc-300">{{ variable.name }}</code>
              <input v-model="envValues[variable.name]" type="password" autocomplete="off" :placeholder="variable.configured ? 'preenchida — colar para trocar' : 'sem valor'" class="input min-w-0 flex-1 font-mono text-sm" />
              <button type="submit" :disabled="busy || !envValues[variable.name]" class="btn btn-sm btn-secondary">Salvar</button>
            </form>
          </div>
        </template>

        <template v-if="selected.kind === 'process'">
          <div class="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span class="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">local (npm)</span>
            <span>{{ selected.status.instances ?? 0 }} em execução — {{ selected.process?.scope === 'shared' ? 'compartilhada' : 'uma por conversa' }}</span>
            <button v-if="selected.status.instances" type="button" class="ml-auto btn btn-sm btn-danger" :disabled="busy" @click="stopAll">Encerrar todas</button>
          </div>
          <label class="field">Nome<input v-model="edit.name" required class="input" /></label>
          <McpProcessFields v-model="processDraft" />
          <div v-if="processDirty || edit.name !== selected.name" class="flex gap-2">
            <button type="button" :disabled="busy" class="btn btn-primary" @click="saveProcess">Salvar alterações</button>
            <span class="self-center text-xs text-zinc-500">As execuções em andamento serão encerradas.</span>
          </div>
          <div v-if="selected.process?.package" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-sm font-medium text-zinc-200">Instalação</h3>
              <span class="text-xs" :class="!selected.install?.installed || selected.install.stale ? 'text-amber-300' : 'text-zinc-400'">
                <template v-if="!selected.install?.installed">não instalado</template>
                <template v-else-if="selected.install.stale">instalado v{{ selected.install.version }} — o pacote mudou, reinstale</template>
                <template v-else>v{{ selected.install.version }}<template v-if="selected.install.installedAt"> · {{ fullTime(selected.install.installedAt) }}</template></template>
              </span>
              <button type="button" :disabled="busy || processDirty" class="ml-auto btn btn-sm btn-primary" @click="install">
                {{ installing ? 'Instalando…' : selected.install?.installed ? 'Reinstalar' : 'Instalar' }}
              </button>
            </div>
            <small v-if="processDirty" class="text-xs text-zinc-500">Salve as alterações antes de instalar.</small>
            <p v-if="installResult" class="text-sm" :class="installResult.ok ? 'text-emerald-300' : 'text-rose-300'">{{ installResult.ok ? `✓ Instalado v${installResult.version}.` : '✕ A instalação falhou. A versão anterior continua.' }}</p>
            <pre v-if="installResult && !installResult.ok && installResult.log" class="max-h-48 overflow-auto rounded-lg bg-zinc-950 p-2 text-[11px] whitespace-pre-wrap text-zinc-400">{{ installResult.log }}</pre>
          </div>
          <div v-if="selected.env?.length" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
            <h3 class="text-sm font-medium text-zinc-200">Variáveis secretas</h3>
            <form v-for="variable in selected.env" :key="variable.name" class="flex flex-wrap items-center gap-2" @submit.prevent="saveEnv(variable.name)">
              <code class="w-40 shrink-0 text-xs text-zinc-300">{{ variable.name }}</code>
              <input v-model="envValues[variable.name]" type="password" autocomplete="off" :placeholder="variable.configured ? 'preenchida — colar para trocar' : 'sem valor'" class="input min-w-0 flex-1 font-mono text-sm" />
              <button type="submit" :disabled="busy || !envValues[variable.name]" class="btn btn-sm btn-secondary">Salvar</button>
            </form>
          </div>
        </template>

        <form v-if="selected.kind === 'remote'" class="flex flex-col gap-3" @submit.prevent="save">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">Nome<input v-model="edit.name" required class="input" /></label>
            <label class="field">URL<input v-model="edit.url" required :readonly="isSelf" class="input font-mono read-only:opacity-60" /></label>
          </div>
          <div class="field">
            Conexão
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(label, value) in TRANSPORT_LABEL" :key="value" type="button" class="chip" :class="{ on: edit.transport === value }" @click="edit.transport = value">{{ label }}</button>
            </div>
          </div>
          <div class="field">
            Autenticação
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="(option, value) in AUTH_LABEL"
                :key="value"
                type="button"
                class="chip disabled:cursor-not-allowed disabled:opacity-40"
                :class="{ on: edit.auth === value }"
                :disabled="isSelf && edit.auth !== value"
                @click="edit.auth = value"
              >
                {{ option.label }}
              </button>
            </div>
            <small class="hint">{{ AUTH_LABEL[edit.auth].hint }}</small>
            <small v-if="isSelf" class="hint">Fixo neste MCP: ele sempre usa o login de quem conversa.</small>
            <small v-if="edit.auth === 'caller' && selected?.id !== 'gateway'" class="text-xs text-amber-300">⚠ O servidor passa a agir como a pessoa que conversa. Só use em servidor seu, de confiança.</small>
          </div>
          <label v-if="edit.auth === 'header'" class="field sm:w-1/2">Cabeçalho<input v-model="edit.headerName" class="input font-mono" /></label>
          <div v-if="dirty" class="flex gap-2">
            <button type="submit" :disabled="busy" class="btn btn-primary">Salvar alterações</button>
          </div>
        </form>

        <div v-if="selected.kind === 'remote' && selected.auth === 'header'" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
          <p class="text-xs" :class="selected.secret.configured ? 'text-zinc-400' : 'text-amber-300'">
            <template v-if="selected.secret.configured">Chave salva · termina em …{{ selected.secret.last4 }}<template v-if="selected.secret.updatedAt"> · {{ fullTime(selected.secret.updatedAt) }}</template></template>
            <template v-else>Sem chave salva: nada é enviado.</template>
          </p>
          <form class="flex flex-wrap items-center gap-2" @submit.prevent="saveSecret">
            <input v-model="secret" type="password" autocomplete="off" spellcheck="false" :placeholder="selected.secret.configured ? 'Colar nova chave para trocar' : 'Colar a chave'" class="input min-w-0 flex-1 font-mono text-sm" />
            <button type="submit" :disabled="busy || !secret.trim()" class="btn btn-primary">Salvar</button>
            <button v-if="selected.secret.configured" type="button" class="btn btn-danger" @click="clearSecret">Remover</button>
          </form>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <button type="button" :disabled="busy || !selected.enabled" class="btn btn-secondary" @click="test">Testar conexão</button>
          <span v-if="testResult" class="text-sm" :class="testResult.ok ? 'text-emerald-300' : 'text-rose-300'">{{ testResult.ok ? `✓ Conectado — ${testResult.tools} ferramenta(s).` : `✕ ${testResult.message}` }}</span>
          <span v-else-if="selected.status.lastError" class="text-xs text-rose-300">Último erro: {{ selected.status.lastError }}</span>
        </div>
        <p v-if="editError" class="text-sm text-rose-300">{{ editError }}</p>

        <div class="border-t border-zinc-800/80 pt-4">
          <h3 class="mb-1 text-sm font-medium text-zinc-200">
            Ferramentas <span class="text-xs font-normal text-zinc-500">{{ tools.length }}<template v-if="tools.length"> · ≈ {{ toolsTokens(tools).toLocaleString('pt-BR') }} tokens no total</template></span>
          </h3>
          <p v-if="tools.length" class="mb-2 text-xs text-zinc-500">
            Cada ferramenta ocupa espaço na conversa do agente, mesmo sem uso. Dê só as necessárias.
          </p>
          <ul v-if="tools.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
            <li v-for="tool in toolsByWeight" :key="tool.name" class="flex items-start gap-3 px-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="font-mono text-[13px] text-zinc-200">{{ tool.name }}</div>
                <div v-if="tool.description" class="text-xs text-zinc-500">{{ tool.description }}</div>
              </div>
              <span class="shrink-0 text-xs text-zinc-500 tabular-nums">≈ {{ toolTokens(tool).toLocaleString('pt-BR') }} tokens</span>
            </li>
          </ul>
          <p v-else-if="toolsError" class="text-xs text-rose-300">{{ toolsError }}</p>
          <p v-else class="text-xs text-zinc-500">{{ selected.enabled ? 'Nenhuma ferramenta listada (servidor fora do ar, ou sem ferramentas).' : 'Ligue o servidor para listar as ferramentas.' }}</p>
        </div>

        <div class="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          <span>Agentes:</span>
          <RouterLink v-for="agent in selected.agents" :key="agent.id" :to="`/agents/${agent.id}`" class="btn btn-sm btn-secondary">{{ agent.name }}</RouterLink>
          <span v-if="!selected.agents.length">nenhum ainda — escolha as ferramentas no formulário do agente</span>
          <button type="button" class="ml-auto text-rose-300 hover:underline" @click="(removing = selected), (removeError = undefined)">Remover MCP</button>
        </div>
      </section>
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um MCP ou adicione um novo.</div>

      <ConfirmDialog
        :open="!!removing"
        :title="`Remover o MCP ${removing?.name ?? ''}?`"
        :message="removeError ?? 'O servidor e a chave dele serão apagados. Não dá se algum agente ainda o usa.'"
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
