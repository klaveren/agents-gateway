<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import { fullTime } from '@/lib/format'
import type { IAgentHook, IHookDelivery, THookInput } from '@/lib/types'
import { useHooksStore } from '@/stores/hooks'
import ConfirmDialog from './ConfirmDialog.vue'

/**
 * A guia Hooks de um agente: cada hook é `POST /v1/hook/<agente>/<hook>`, e o agente executa o prompt dele
 * com o evento recebido. ⚠️ Mora DENTRO do formulário do agente: nada aqui é `<form>` nem submete com Enter
 * — o Salvar do agente é outro —, e nenhum input tem validação nativa (`pattern`, `required`): ela barraria
 * o Salvar do agente. Quem valida o hook é o servidor.
 */
const props = defineProps<{ agentId: string }>()
const hooks = useHooksStore()

const list = computed(() => hooks.byAgent[props.agentId] ?? [])
const loadError = ref<string>()
/** O hook aberto: `''` = um novo; `undefined` = nenhum. */
const open = ref<string>()
const draft = ref<THookInput & { name: string }>(blank())
const issues = ref<Record<string, string[]>>({})
const error = ref<string>()
const busy = ref(false)
/** A chave que acabou de nascer (criar ou trocar). ⛔ Só existe nesta tela, agora. */
const revealed = ref<{ name: string; secret: string }>()
const copied = ref<string>()
const deliveries = ref<IHookDelivery[]>([])
const confirm = ref<{ kind: 'rotate' | 'remove'; name: string }>()

function blank(): THookInput & { name: string } {
  return { name: '', prompt: '', enabled: true, verify: 'key', signatureHeader: 'X-Hub-Signature-256', signaturePrefix: 'sha256=', signatureEncoding: 'hex', session: 'new' }
}

onMounted(() => reload())
watch(
  () => props.agentId,
  () => reload(),
)

async function reload() {
  loadError.value = undefined
  await hooks.load(props.agentId).catch((failure) => (loadError.value = describe(failure)))
}

function describe(failure: unknown): string {
  if (failure instanceof ApiError && failure.status === 422) {
    const items = Array.isArray(failure.details) ? (failure.details as Array<{ field?: string; message?: string }>) : []
    return items.map((item) => (item.field ? `${item.field}: ${item.message}` : item.message)).join('; ') || failure.message
  }
  return failure instanceof Error ? failure.message : String(failure)
}

const selected = computed(() => list.value.find((hook) => hook.name === open.value))
// ⚠️ No script, e não no template: lá `undefined` não é garantido como o valor global no build.
const editing = computed(() => open.value !== undefined)
const addingNew = computed(() => open.value === '')
const urlOf = (hook: Pick<IAgentHook, 'path'>) => `${location.origin}${hook.path}`

async function openHook(name: string | undefined) {
  issues.value = {}
  error.value = undefined
  deliveries.value = []
  if (open.value === name) return (open.value = undefined)
  open.value = name
  const hook = list.value.find((entry) => entry.name === name)
  draft.value = hook ? { name: hook.name, prompt: hook.prompt, enabled: hook.enabled, verify: hook.verify, signatureHeader: hook.signatureHeader, signaturePrefix: hook.signaturePrefix, signatureEncoding: hook.signatureEncoding, session: hook.session } : blank()
  if (hook) await loadDeliveries()
}

async function loadDeliveries() {
  if (!selected.value) return
  deliveries.value = await hooks.deliveries(props.agentId, selected.value.name).catch(() => [])
}

async function run(work: () => Promise<void>) {
  busy.value = true
  error.value = undefined
  issues.value = {}
  try {
    await work()
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) issues.value = failure.fieldIssues
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

const create = () =>
  run(async () => {
    const created = await hooks.create(props.agentId, draft.value)
    if (created.secret) revealed.value = { name: created.name, secret: created.secret }
    open.value = created.name
    await loadDeliveries()
  })

const save = () =>
  run(async () => {
    const { name, ...change } = draft.value
    await hooks.update(props.agentId, name, change)
  })

async function confirmed() {
  const target = confirm.value
  confirm.value = undefined
  if (!target) return
  await run(async () => {
    if (target.kind === 'rotate') {
      const rotated = await hooks.rotate(props.agentId, target.name)
      if (rotated.secret) revealed.value = { name: rotated.name, secret: rotated.secret }
    } else {
      await hooks.remove(props.agentId, target.name)
      if (revealed.value?.name === target.name) revealed.value = undefined
      open.value = undefined
    }
  })
}

async function copy(label: string, text: string) {
  await navigator.clipboard?.writeText(text).catch(() => undefined)
  copied.value = label
  setTimeout(() => (copied.value = undefined), 1500)
}

/** O `curl` de exemplo: com a chave no header, ou com a assinatura do corpo (HMAC, como o GitHub manda). */
function curlOf(hook: IAgentHook, secret: string): string {
  const url = urlOf(hook)
  const body = `'{"evento":"teste"}'`
  if (hook.verify === 'key') return `curl -X POST '${url}' \\\n  -H 'X-Hook-Key: ${secret}' \\\n  -H 'Content-Type: application/json' \\\n  -d ${body}`
  const digest = hook.signatureEncoding === 'hex' ? 'openssl dgst -sha256 -hmac "$KEY" | sed "s/^.* //"' : 'openssl dgst -sha256 -hmac "$KEY" -binary | base64'
  return `KEY='${secret}'\nBODY=${body}\nSIG="${hook.signaturePrefix}$(printf %s "$BODY" | ${digest})"\ncurl -X POST '${url}' \\\n  -H "${hook.signatureHeader}: $SIG" \\\n  -H 'Content-Type: application/json' \\\n  -d "$BODY"`
}

const STATUS: Record<IHookDelivery['status'], { label: string; tone: string }> = {
  running: { label: 'rodando', tone: 'text-amber-300' },
  ok: { label: 'ok', tone: 'text-emerald-300' },
  error: { label: 'erro', tone: 'text-rose-300' },
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-xs text-zinc-500">
      Cada hook é uma URL que um serviço externo (GitHub, CRM, cron) chama com um evento. O agente executa o prompt do hook com o evento junto, em nome de quem criou o hook, e a conversa aparece na caixa de entrada dessa conta.
    </p>
    <p v-if="loadError" class="text-sm text-rose-300">{{ loadError }}</p>

    <div v-if="revealed" class="flex flex-col gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
      <div class="flex items-center gap-2">
        <strong class="text-emerald-200">Chave do hook {{ revealed.name }}</strong>
        <span class="text-xs text-emerald-300/80">— só aparece agora. Copie e guarde.</span>
        <button type="button" class="ml-auto text-xs text-zinc-400 hover:text-zinc-200" @click="revealed = undefined">fechar</button>
      </div>
      <div class="flex items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-100">{{ revealed.secret }}</code>
        <button type="button" class="rounded-full bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700" @click="copy('secret', revealed.secret)">{{ copied === 'secret' ? 'copiada' : 'copiar' }}</button>
      </div>
      <template v-for="hook in list.filter((entry) => entry.name === revealed?.name)" :key="hook.name">
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 truncate rounded bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300">{{ urlOf(hook) }}</code>
          <button type="button" class="rounded-full bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700" @click="copy('url', urlOf(hook))">{{ copied === 'url' ? 'copiada' : 'copiar URL' }}</button>
        </div>
        <pre class="overflow-x-auto rounded bg-zinc-950 p-2 text-[11px] text-zinc-400">{{ curlOf(hook, revealed.secret) }}</pre>
        <p v-if="hook.verify === 'hmac'" class="text-xs text-zinc-400">No GitHub: Settings → Webhooks → Add webhook. Payload URL = a URL acima, Content type = application/json, Secret = esta chave.</p>
      </template>
    </div>

    <ul class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
      <li v-for="hook in list" :key="hook.name">
        <button type="button" class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-800/40" @click="openHook(hook.name)">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="hook.enabled ? 'bg-emerald-400' : 'bg-zinc-600'" />
          <span class="min-w-0 flex-1">
            <span class="block truncate font-mono text-[13px] text-zinc-200">{{ hook.name }}</span>
            <span class="block truncate text-xs text-zinc-500">
              {{ hook.verify === 'hmac' ? 'assinatura HMAC' : 'chave no header' }} · {{ hook.session === 'continuous' ? 'conversa contínua' : 'conversa nova por chamada' }}
              <template v-if="hook.lastDelivery"> · última: {{ fullTime(hook.lastDelivery.receivedAt) }} ({{ STATUS[hook.lastDelivery.status].label }})</template>
            </span>
          </span>
          <span class="text-xs text-zinc-500">{{ open === hook.name ? '▴' : '▾' }}</span>
        </button>
      </li>
      <li v-if="!list.length && !loadError" class="px-3 py-3 text-xs text-zinc-500">Nenhum hook ainda.</li>
    </ul>
    <button v-if="!addingNew" type="button" class="self-start rounded-full bg-zinc-800 px-4 py-1.5 text-sm hover:bg-zinc-700" @click="openHook('')">+ Novo hook</button>

    <div v-if="editing" class="flex flex-col gap-3 rounded-xl border border-zinc-800 p-3">
      <h3 class="text-sm font-medium text-zinc-200">{{ selected ? `Hook ${selected.name}` : 'Novo hook' }}</h3>
      <div v-if="selected" class="flex items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300">POST {{ urlOf(selected) }}</code>
        <button type="button" class="rounded-full bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700" @click="copy('url', urlOf(selected))">{{ copied === 'url' ? 'copiada' : 'copiar' }}</button>
      </div>
      <label v-if="!selected" class="field">
        Nome
        <input v-model="draft.name" class="input font-mono" placeholder="deploy" @keydown.enter.prevent />
        <small class="hint">Vira o fim da URL: <code>/v1/hook/{{ agentId }}/{{ draft.name || 'nome' }}</code>. Não muda depois.</small>
        <small v-for="m in issues.name" :key="m" class="error">{{ m }}</small>
      </label>
      <label class="field">
        Prompt
        <textarea v-model="draft.prompt" rows="5" class="input text-sm" placeholder="Um push chegou. Revise o que mudou e me diga se algo quebra o deploy." />
        <small class="hint">O que o agente faz quando o evento chega. O evento (corpo, headers x-*, query) vai logo abaixo, sem a chave.</small>
        <small v-for="m in issues.prompt" :key="m" class="error">{{ m }}</small>
      </label>
      <div class="field">
        Verificação
        <div class="flex flex-wrap gap-1.5">
          <button type="button" class="chip" :class="{ on: draft.verify === 'key' }" @click="draft.verify = 'key'">Chave no header</button>
          <button type="button" class="chip" :class="{ on: draft.verify === 'hmac' }" @click="draft.verify = 'hmac'">Assinatura HMAC</button>
        </div>
        <small class="hint">{{ draft.verify === 'key' ? 'Quem chama manda a chave em Authorization: Bearer … ou em X-Hook-Key.' : 'Quem chama assina o corpo com a chave (HMAC-SHA256), como GitHub e Gitea fazem. A chave sozinha não basta.' }}</small>
      </div>
      <div v-if="draft.verify === 'hmac'" class="grid gap-3 sm:grid-cols-3">
        <label class="field">Header da assinatura<input v-model="draft.signatureHeader" class="input font-mono text-xs" @keydown.enter.prevent /></label>
        <label class="field">Prefixo<input v-model="draft.signaturePrefix" class="input font-mono text-xs" @keydown.enter.prevent /></label>
        <div class="field">
          Codificação
          <div class="flex gap-1.5">
            <button type="button" class="chip" :class="{ on: draft.signatureEncoding === 'hex' }" @click="draft.signatureEncoding = 'hex'">hex</button>
            <button type="button" class="chip" :class="{ on: draft.signatureEncoding === 'base64' }" @click="draft.signatureEncoding = 'base64'">base64</button>
          </div>
        </div>
      </div>
      <div class="field">
        Conversa
        <div class="flex flex-wrap gap-1.5">
          <button type="button" class="chip" :class="{ on: draft.session === 'new' }" @click="draft.session = 'new'">Nova a cada chamada</button>
          <button type="button" class="chip" :class="{ on: draft.session === 'continuous' }" @click="draft.session = 'continuous'">Contínua</button>
        </div>
        <small class="hint">{{ draft.session === 'new' ? 'Cada evento vira uma conversa; chamadas juntas rodam em paralelo.' : 'Todos os eventos na mesma conversa (o agente lembra dos anteriores); chamadas juntas entram em fila.' }}</small>
      </div>
      <label class="flex items-center gap-2 text-sm text-zinc-300"><input v-model="draft.enabled" type="checkbox" class="accent-emerald-500" /> Ligado</label>

      <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <div class="flex flex-wrap gap-2">
        <button v-if="!selected" type="button" :disabled="busy" class="rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="create">Criar hook</button>
        <template v-else>
          <button type="button" :disabled="busy" class="rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="save">Salvar hook</button>
          <button type="button" :disabled="busy" class="rounded-full bg-zinc-800 px-4 py-1.5 text-sm hover:bg-zinc-700" @click="confirm = { kind: 'rotate', name: selected.name }">Trocar chave</button>
          <span v-if="selected.secretLast4" class="self-center text-xs text-zinc-500">chave termina em …{{ selected.secretLast4 }}</span>
          <button type="button" :disabled="busy" class="ml-auto rounded-full px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-500/10" @click="confirm = { kind: 'remove', name: selected.name }">Apagar</button>
        </template>
      </div>

      <div v-if="selected" class="border-t border-zinc-800/80 pt-3">
        <div class="mb-2 flex items-center gap-2">
          <h4 class="text-sm font-medium text-zinc-200">Últimas chamadas</h4>
          <button type="button" class="ml-auto text-xs text-zinc-400 hover:text-zinc-200" @click="loadDeliveries">atualizar</button>
        </div>
        <ul v-if="deliveries.length" class="divide-y divide-zinc-800 rounded-lg border border-zinc-800 text-xs">
          <li v-for="delivery in deliveries" :key="delivery.id" class="flex items-center gap-3 px-3 py-1.5">
            <span class="w-36 shrink-0 text-zinc-400">{{ fullTime(delivery.receivedAt) }}</span>
            <span class="w-14 shrink-0" :class="STATUS[delivery.status].tone">{{ STATUS[delivery.status].label }}</span>
            <span class="min-w-0 flex-1 truncate text-rose-300/80">{{ delivery.error }}</span>
            <RouterLink v-if="delivery.sessionId" :to="`/c/${delivery.sessionId}`" class="shrink-0 text-emerald-300 hover:underline">conversa</RouterLink>
          </li>
        </ul>
        <p v-else class="text-xs text-zinc-500">Nenhuma chamada ainda.</p>
      </div>
    </div>

    <ConfirmDialog
      :open="!!confirm"
      :title="confirm?.kind === 'rotate' ? `Trocar a chave do hook ${confirm?.name}?` : `Apagar o hook ${confirm?.name ?? ''}?`"
      :message="confirm?.kind === 'rotate' ? 'A chave atual para de valer na hora: quem chama precisa da nova.' : 'A URL para de responder e a chave some. As conversas que ele abriu continuam.'"
      :action="confirm?.kind === 'rotate' ? 'Trocar' : 'Apagar'"
      :tone="confirm?.kind === 'rotate' ? 'neutral' : 'danger'"
      @confirm="confirmed"
      @cancel="confirm = undefined"
    />
  </div>
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
</style>
