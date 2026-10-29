<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api, ApiError } from '@/lib/api'
import { fullTime } from '@/lib/format'
import type { IPermissionRule } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * As CONTAS do projeto em uso (só admin): as credenciais que o terminal dos agentes dele recebe — o GitHub da empresa,
 * uma variável secreta. O segredo entra e nunca volta para a tela. Quem usa cada conta: a permissão `Contas` (no
 * projeto ou no agente). As contas não liberam rede: o destino precisa da regra de rede.
 */
type TKind = 'github-app' | 'github-token' | 'gcp-service-account' | 'ssh-ca' | 'ssh-key' | 'secret-env'
interface IAccount {
  id: string
  kind: TKind
  label: string
  public: {
    owner?: string
    appId?: string
    installationId?: string
    repositories?: string[]
    envName?: string
    gcpProject?: string
    clientEmail?: string
    principals?: string[]
    validityMinutes?: number
    hostPatterns?: string[]
    knownHosts?: string
    publicKey?: string
    certificate?: string
    last4?: string
  }
  exposesSecret: boolean
  updatedAt: string
  updatedBy?: string
}

const KINDS: Array<{ kind: TKind; label: string; hint: string }> = [
  { kind: 'github-app', label: 'GitHub App', hint: 'Recomendado. O comando recebe um token de 1h, só dos repositórios escolhidos; a chave do App fica no gateway.' },
  { kind: 'github-token', label: 'GitHub token', hint: 'Um token pessoal (PAT). O comando recebe o próprio token.' },
  {
    kind: 'gcp-service-account',
    label: 'GCP (conta de serviço)',
    hint: 'O comando recebe um access token de 1h para o gcloud (CLOUDSDK_AUTH_ACCESS_TOKEN) e o projeto padrão; o JSON da conta fica no gateway.',
  },
  {
    kind: 'ssh-ca',
    label: 'SSH (certificado do gateway)',
    hint: 'Recomendado para servidores. O gateway gera a CA do projeto; cada comando recebe uma chave nova com certificado de minutos. No servidor, confie na CA (TrustedUserCAKeys).',
  },
  { kind: 'ssh-key', label: 'SSH (chave importada)', hint: 'Uma chave sua (sem senha), com o certificado dela se houver. O comando recebe a própria chave; o ssh_sign assina com ela sem expô-la.' },
  { kind: 'secret-env', label: 'Variável secreta', hint: 'Um valor numa variável de ambiente (ex.: GITLAB_TOKEN). O comando recebe o próprio valor.' },
]

const auth = useAuthStore()
const projects = useProjectsStore()
const project = computed(() => projects.list.find((item) => item.id === projects.current))

const accounts = ref<IAccount[]>([])
const error = ref<string>()
const notice = ref<string>()
const busy = ref(false)
const tests = ref<Record<string, { ok: boolean; detail: string }>>({})
const editing = ref<string | null>(null)
const form = ref(blank())

function blank() {
  return { id: '', kind: 'github-app' as TKind, label: '', owner: '', appId: '', installationId: '', repositories: '', envName: '', gcpProject: '', principals: '', validityMinutes: '', hostPatterns: '', knownHosts: '', certificate: '', secret: '' }
}

const base = computed(() => (project.value ? `/projects/${encodeURIComponent(project.value.id)}/accounts` : ''))
const kindLabel = (kind: TKind) => KINDS.find((item) => item.kind === kind)?.label ?? kind
const kindHint = computed(() => KINDS.find((item) => item.kind === form.value.kind)?.hint)

async function load() {
  if (!project.value) return
  error.value = undefined
  try {
    accounts.value = (await api<{ accounts: IAccount[] }>(base.value)).accounts
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  }
}

function startNew() {
  editing.value = ''
  form.value = blank()
  notice.value = undefined
}

function startEdit(account: IAccount) {
  editing.value = account.id
  form.value = {
    ...blank(),
    id: account.id,
    kind: account.kind,
    label: account.label,
    owner: account.public.owner ?? '',
    appId: account.public.appId ?? '',
    installationId: account.public.installationId ?? '',
    repositories: (account.public.repositories ?? []).join(', '),
    envName: account.public.envName ?? '',
    gcpProject: account.public.gcpProject ?? '',
    principals: (account.public.principals ?? []).join(', '),
    validityMinutes: account.public.validityMinutes ? String(account.public.validityMinutes) : '',
    hostPatterns: (account.public.hostPatterns ?? []).join(' '),
    knownHosts: account.public.knownHosts ?? '',
    certificate: account.public.certificate ?? '',
  }
  notice.value = undefined
}

async function save() {
  if (!project.value) return
  busy.value = true
  error.value = undefined
  try {
    const { id, kind, label, owner, appId, installationId, repositories, envName, gcpProject, principals, validityMinutes, hostPatterns, knownHosts, certificate, secret } = form.value
    const isSsh = kind === 'ssh-ca' || kind === 'ssh-key'
    const list = (value: string) => value.split(/[\s,]+/).filter(Boolean)
    const isGitHub = kind === 'github-app' || kind === 'github-token'
    await api(`${base.value}/${encodeURIComponent(id.trim())}`, {
      method: 'PUT',
      body: {
        kind,
        label,
        public: {
          ...(isGitHub && owner.trim() ? { owner: owner.trim() } : {}),
          ...(kind === 'github-app' ? { appId, installationId, repositories: repositories.split(/[\s,]+/).filter(Boolean) } : {}),
          ...(kind === 'secret-env' ? { envName: envName.trim() } : {}),
          ...(kind === 'gcp-service-account' && gcpProject.trim() ? { gcpProject: gcpProject.trim() } : {}),
          ...(isSsh ? { knownHosts, hostPatterns: list(hostPatterns) } : {}),
          ...(kind === 'ssh-ca' ? { principals: list(principals), ...(validityMinutes.trim() ? { validityMinutes: Number(validityMinutes) } : {}) } : {}),
          ...(kind === 'ssh-key' && certificate.trim() ? { certificate: certificate.trim() } : {}),
        },
        ...(secret.trim() && kind !== 'ssh-ca' ? { secret } : {}),
      },
    })
    notice.value = `Conta ${id} salva. Para um agente usar, libere "${id}" em Contas, nas Permissões.`
    editing.value = null
    await load()
  } catch (failure) {
    error.value =
      failure instanceof ApiError && Array.isArray(failure.details)
        ? (failure.details as Array<{ message: string }>).map((item) => item.message).join('; ')
        : failure instanceof Error
          ? failure.message
          : String(failure)
  } finally {
    busy.value = false
  }
}

async function remove(account: IAccount) {
  if (!confirm(`Apagar a conta ${account.id}? Os agentes deixam de recebê-la na hora.`)) return
  await api(`${base.value}/${encodeURIComponent(account.id)}`, { method: 'DELETE' }).catch((failure) => (error.value = String(failure)))
  await load()
}

async function test(account: IAccount) {
  tests.value = { ...tests.value, [account.id]: { ok: true, detail: 'testando…' } }
  try {
    tests.value = { ...tests.value, [account.id]: await api<{ ok: boolean; detail: string }>(`${base.value}/${encodeURIComponent(account.id)}/test`, { method: 'POST' }) }
  } catch (failure) {
    tests.value = { ...tests.value, [account.id]: { ok: false, detail: failure instanceof Error ? failure.message : String(failure) } }
  }
}

/** As regras que a conta pede: a de uso (`Contas`) e a de rede do GitHub. */
function suggested(account: IAccount): IPermissionRule[] {
  const rules: IPermissionRule[] = [{ category: 'account', pattern: account.id, decision: 'allow' }]
  if (account.kind === 'github-app' || account.kind === 'github-token')
    rules.push({ category: 'network', pattern: 'github.com:443', decision: 'allow' }, { category: 'network', pattern: 'api.github.com:443', decision: 'allow' })
  if (account.kind === 'gcp-service-account') rules.push({ category: 'network', pattern: '*.googleapis.com:443', decision: 'allow' })
  if (account.kind === 'ssh-ca' || account.kind === 'ssh-key')
    for (const host of knownHostNames(account.public.knownHosts)) rules.push({ category: 'network', pattern: `${host}:22`, decision: 'allow' })
  return rules
}

/** Os hosts dos known_hosts (o primeiro campo, sem `[...]:porta` nem os hasheados), para sugerir a regra de rede. */
function knownHostNames(knownHosts = ''): string[] {
  const names = knownHosts
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('|'))
    .flatMap((line) => line.split(/\s+/)[0].split(','))
    .filter((name) => !name.startsWith('['))
  return [...new Set(names)]
}

async function addRules(account: IAccount) {
  if (!project.value) return
  const path = `/projects/${encodeURIComponent(project.value.id)}/permissions`
  try {
    const current = (await api<{ rules: IPermissionRule[] }>(path)).rules
    const missing = suggested(account).filter((rule) => !current.some((item) => item.category === rule.category && item.pattern === rule.pattern))
    if (missing.length) await api(path, { method: 'PUT', body: { rules: [...current, ...missing] } })
    notice.value = missing.length ? `${missing.length} regra(s) adicionada(s) às Permissões do projeto.` : 'As regras já estavam nas Permissões do projeto.'
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  }
}

onMounted(async () => {
  if (!auth.isAdmin) return
  if (!projects.loaded) await projects.load().catch(() => undefined)
  await load()
})
watch(
  () => projects.current,
  () => {
    editing.value = null
    if (auth.isAdmin) void load()
  },
)
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra vê as contas do projeto.</p>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-semibold">Contas{{ project ? ` — ${project.name}` : '' }}</h1>
          <p class="text-xs text-zinc-500">As credenciais que o terminal dos agentes deste projeto recebe. Os outros projetos não as veem.</p>
        </div>
        <button v-if="project && editing === null" type="button" class="btn btn-primary btn-sm" @click="startNew">Nova conta</button>
      </header>

      <p v-if="!project" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Escolha um projeto no seletor do topo.</p>
      <template v-else>
        <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <strong class="font-medium">O que o comando usa, o comando consegue mostrar.</strong> Prefira o GitHub App: o agente recebe um token de 1h, e a chave fica no
          gateway. Cada conta só chega a quem tem a permissão dela (Contas), e o destino precisa da regra de rede.
        </div>
        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
        <p v-if="notice" class="text-sm text-emerald-300">{{ notice }}</p>

        <form v-if="editing !== null" class="flex flex-col gap-3 rounded-xl border border-zinc-800 p-3" @submit.prevent="save">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="field">
              Tipo
              <select v-model="form.kind" class="input" :disabled="!!editing">
                <option v-for="item in KINDS" :key="item.kind" :value="item.kind">{{ item.label }}</option>
              </select>
            </label>
            <label class="field">
              Id
              <input v-model="form.id" class="input font-mono" :disabled="!!editing" placeholder="github-empresa1" required />
            </label>
            <label class="field sm:col-span-2">Nome<input v-model="form.label" class="input" placeholder="GitHub da Empresa 1" /></label>
          </div>
          <p class="text-xs text-zinc-500">{{ kindHint }}</p>

          <template v-if="form.kind === 'ssh-ca' || form.kind === 'ssh-key'">
            <div class="grid gap-3 sm:grid-cols-2">
              <label v-if="form.kind === 'ssh-ca'" class="field">Usuários remotos (principals)<input v-model="form.principals" class="input font-mono" placeholder="deploy, app" /></label>
              <label v-if="form.kind === 'ssh-ca'" class="field">Validade do certificado (minutos, até 60)<input v-model="form.validityMinutes" class="input font-mono" inputmode="numeric" placeholder="10" /></label>
              <label class="field sm:col-span-2">Hosts em que vale (vazio = todos)<input v-model="form.hostPatterns" class="input font-mono" placeholder="*.empresa1.com git.empresa1.com" /></label>
            </div>
            <label class="field">
              known_hosts aceitos (servidor fora da lista é recusado)
              <textarea v-model="form.knownHosts" class="input font-mono text-xs" rows="3" placeholder="servidor.empresa1.com ssh-ed25519 AAAA… (a saída do ssh-keyscan)" spellcheck="false" />
            </label>
            <label v-if="form.kind === 'ssh-key'" class="field">
              Certificado da chave (-cert.pub, se houver)
              <textarea v-model="form.certificate" class="input font-mono text-xs" rows="2" spellcheck="false" />
            </label>
          </template>
          <label v-else-if="form.kind === 'gcp-service-account'" class="field">
            Projeto do GCP (vazio = o do JSON)<input v-model="form.gcpProject" class="input font-mono" placeholder="projeto-empresa-1" />
          </label>
          <div v-else-if="form.kind !== 'secret-env'" class="grid gap-3 sm:grid-cols-2">
            <label class="field">Dono (organização ou usuário)<input v-model="form.owner" class="input font-mono" placeholder="empresa1" /></label>
            <template v-if="form.kind === 'github-app'">
              <label class="field">App ID<input v-model="form.appId" class="input font-mono" inputmode="numeric" /></label>
              <label class="field">Installation ID<input v-model="form.installationId" class="input font-mono" inputmode="numeric" /></label>
              <label class="field">Repositórios (vazio = todos da instalação)<input v-model="form.repositories" class="input font-mono" placeholder="api, web" /></label>
            </template>
          </div>
          <label v-else class="field">Nome da variável<input v-model="form.envName" class="input font-mono" placeholder="GITLAB_TOKEN" /></label>

          <p v-if="form.kind === 'ssh-ca'" class="text-xs text-zinc-500">A chave da CA nasce no gateway ao salvar e não sai dele; a pública aparece na lista, para os servidores.</p>
          <label v-else class="field">
            {{ { 'github-app': 'Chave privada do App (.pem)', 'github-token': 'Token', 'gcp-service-account': 'JSON da conta de serviço', 'ssh-key': 'Chave privada SSH (sem senha)', 'ssh-ca': '', 'secret-env': 'Valor' }[form.kind] }}
            <textarea v-model="form.secret" class="input font-mono text-xs" :rows="form.kind === 'github-app' || form.kind === 'gcp-service-account' || form.kind === 'ssh-key' ? 6 : 2" :placeholder="editing ? 'Em branco: mantém o guardado' : ''" autocomplete="off" spellcheck="false" />
          </label>
          <div class="flex gap-2">
            <button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !form.id.trim()">Salvar</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="editing = null">Cancelar</button>
          </div>
        </form>

        <ul v-if="accounts.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
          <li v-for="account in accounts" :key="account.id" class="flex flex-col gap-1.5 px-3 py-2.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium text-zinc-100">{{ account.label }}</span>
              <code class="text-xs text-zinc-500">{{ account.id }}</code>
              <span class="rounded-full border border-zinc-700 px-2 text-[11px] text-zinc-400">{{ kindLabel(account.kind) }}</span>
              <span v-if="account.exposesSecret" class="rounded-full border border-amber-500/40 px-2 text-[11px] text-amber-200" title="O comando recebe o próprio segredo">o agente vê o segredo</span>
              <span class="ml-auto flex gap-1">
                <button type="button" class="btn btn-ghost btn-sm" @click="test(account)">Testar</button>
                <button type="button" class="btn btn-ghost btn-sm" @click="startEdit(account)">Editar</button>
                <button type="button" class="btn btn-ghost btn-sm text-rose-300" @click="remove(account)">Apagar</button>
              </span>
            </div>
            <p class="text-xs text-zinc-500">
              <template v-if="account.public.owner">dono {{ account.public.owner }} · </template>
              <template v-if="account.public.appId">App {{ account.public.appId }}, instalação {{ account.public.installationId }} · </template>
              <template v-if="account.public.repositories?.length">repositórios {{ account.public.repositories.join(', ') }} · </template>
              <template v-if="account.public.envName">variável {{ account.public.envName }} · </template>
              <template v-if="account.public.clientEmail">{{ account.public.clientEmail }} · </template>
              <template v-if="account.public.gcpProject">projeto {{ account.public.gcpProject }} · </template>
              <template v-if="account.public.principals?.length">usuários {{ account.public.principals.join(', ') }} · </template>
              <template v-if="account.public.hostPatterns?.length">hosts {{ account.public.hostPatterns.join(' ') }} · </template>
              <template v-if="account.public.last4">…{{ account.public.last4 }} · </template>
              alterada por {{ account.updatedBy ?? '—' }} em {{ fullTime(account.updatedAt) }}
            </p>
            <div v-if="account.kind === 'ssh-ca' && account.public.publicKey" class="flex flex-col gap-1 rounded-lg bg-zinc-900 px-2 py-1.5 text-xs">
              <span class="text-zinc-400">No servidor: grave em <code>/etc/ssh/ca.pub</code> e ponha <code>TrustedUserCAKeys /etc/ssh/ca.pub</code> no sshd_config. Ou, num usuário, a linha no authorized_keys:</span>
              <code class="break-all text-zinc-200">cert-authority {{ account.public.publicKey }}</code>
            </div>
            <p v-if="tests[account.id]" class="text-xs" :class="tests[account.id].ok ? 'text-emerald-300' : 'text-rose-300'">{{ tests[account.id].detail }}</p>
            <p class="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              Regras:
              <code v-for="rule in suggested(account)" :key="rule.category + rule.pattern" class="text-zinc-300">{{ rule.category === 'account' ? 'conta' : 'rede' }} {{ rule.pattern }}</code>
              <button type="button" class="btn btn-ghost btn-sm" @click="addRules(account)">Adicionar às Permissões do projeto</button>
            </p>
          </li>
        </ul>
        <p v-else-if="editing === null" class="text-xs text-zinc-500">Nenhuma conta neste projeto.</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
