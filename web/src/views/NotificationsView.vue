<script setup lang="ts">
  import { computed, ref } from 'vue'
  import ConfirmDialog from '@/components/ConfirmDialog.vue'
  import ListPager from '@/components/ListPager.vue'
  import { ApiError } from '@/lib/api'
  import type { IWideningRef } from '@/lib/catalogHistory'
  import {
    batchKey,
    type IPermissionRequest,
    isRestoration,
    itemSummary,
    kindLabel,
    originLabel,
    patchLine,
    requestEntriesLine,
    ruleLine,
    secretLine,
    secretProjectLine,
    targetTitle,
  } from '@/lib/permissionRequests'
  import { PAGE_SIZE, usePaged } from '@/composables/usePaged'
  import { useResource } from '@/composables/useResource'
  import { useProjectsStore } from '@/stores/projects'
  import { usePermissionRequestsStore } from '@/stores/permissionRequests'

  /**
   * As NOTIFICAÇÕES (só quem administra projeto): os pedidos de permissão abertos dos agentes (o servidor devolve os dos
   * projetos de que a pessoa é admin), num lugar só. Cada pedido é UM item (uma regra, um campo, uma ferramenta).
   * ⚖️ A tela separa por LOTE — a chamada do agente que gerou os pedidos (`batchId`) —: quem pediu, quando, de qual
   * conversa, o motivo e quantos itens. Os pedidos antigos, sem lote, ficam juntos no lote "sem origem".
   * ⚖️ Cada item diz de onde vem (incidente de 26/11): `restauração` (o alvo já teve isso numa revisão anterior do catálogo)
   * ou `ampliação nova` (nunca teve).
   * ⛔ "Aprovar este lote" leva SÓ as restaurações. A ampliação nova se aprova item a item, ou num "Aprovar as N ampliações
   * novas" à parte, que lista cada uma antes. Não há "aprovar todos" da tela inteira: foi o caminho às cegas.
   * ⛔ Aprovar UM item manda as chaves de todas as ampliações dele e só liga com todas marcadas — igual à `WideningConfirm`.
   * A lista de uma aprovação em lote é mostrada antes: confirmar a lista é confirmar cada ampliação dela, e só o que foi
   * listado é aprovado. ⛔ A variável secreta fica fora de toda aprovação em lote: ela só vale com o valor digitado no item.
   * ⚖️ Os pedidos vêm da lista de todos da store (a mesma do selo), que anda sozinha com o `catalog.changed`.
   */
  const projects = useProjectsStore()
  const projectNameOf = (id: string) => projects.list.find((project) => project.id === id)?.name
  const store = usePermissionRequestsStore()
  const { data, loading } = useResource(store.lists, () => (projects.managesAny ? '' : undefined))

  interface IBatch {
    /** O `batchId`; `''` = sem origem. */
    key: string
    /** O primeiro pedido do lote: quem pediu, o motivo, a conversa (os mesmos em todo o lote). */
    head: IPermissionRequest
    /** Os alvos (o agente, o projeto, a skill): um só num lote de verdade. */
    targets: string[]
    createdAt: string
    items: IPermissionRequest[]
  }

  const newestFirst = (a: IPermissionRequest, b: IPermissionRequest) => b.createdAt.localeCompare(a.createdAt)
  const pending = computed(() => (data.value ?? []).filter((request) => request.status === 'pending').sort(newestFirst))
  const expired = computed(() => (data.value ?? []).filter((request) => request.status === 'expired').sort(newestFirst))

  /** Por lote; a ordem é a do pedido mais novo de cada um. O "sem origem" vai por último. */
  function batched(requests: readonly IPermissionRequest[]): IBatch[] {
    const byKey = new Map<string, IBatch>()
    for (const request of requests) {
      const key = batchKey(request)
      const batch = byKey.get(key) ?? { key, head: request, targets: [], createdAt: request.createdAt, items: [] }
      const title = targetTitle(request)
      if (!batch.targets.includes(title)) batch.targets.push(title)
      if (request.createdAt.localeCompare(batch.createdAt) > 0) batch.createdAt = request.createdAt
      batch.items.push(request)
      byKey.set(key, batch)
    }
    const list = [...byKey.values()]
    return [...list.filter((batch) => batch.key), ...list.filter((batch) => !batch.key)]
  }
  const batches = computed(() => batched(pending.value))
  const batchPage = usePaged(batches, { by: (batch) => batch.key })
  const expiredPage = usePaged(expired, { by: (request) => request.id })

  // A página de cada lote (um lote com centenas de itens não empurra os outros para fora da tela).
  const itemPages = ref<Record<string, number>>({})
  const visible = computed(() =>
    batchPage.items.value.map((batch) => {
      const pages = Math.max(1, Math.ceil(batch.items.length / PAGE_SIZE))
      const page = Math.min(itemPages.value[batch.key] ?? 0, pages - 1)
      return { ...batch, pages, page, shown: batch.items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) }
    }),
  )

  const tab = ref<'pending' | 'expired'>('pending')
  /** Sem vencido, a guia some: a tela volta aos pendentes. */
  const showing = computed(() => (tab.value === 'expired' && expired.value.length ? 'expired' : 'pending'))

  // As caixas: por pedido, as chaves de ampliação marcadas.
  const checked = ref<Record<string, string[]>>({})
  /** ⛔ O valor digitado de cada pedido `secret`: só existe aqui, até aprovar (aí é apagado), e nunca vem do servidor. */
  const values = ref<Record<string, string>>({})
  const valueOf = (request: IPermissionRequest) => values.value[request.id] ?? ''

  const keysOf = (request: IPermissionRequest) => request.widenings.map((item) => item.key)
  const isChecked = (request: IPermissionRequest, key: string) => (checked.value[request.id] ?? []).includes(key)
  /** ⛔ O Aprovar do item: todas as ampliações dele marcadas e, no pedido `secret`, o valor digitado. */
  const ready = (request: IPermissionRequest) => keysOf(request).every((key) => isChecked(request, key)) && (request.kind !== 'secret' || !!valueOf(request))

  function toggleKey(request: IPermissionRequest, key: string, on: boolean) {
    const current = (checked.value[request.id] ?? []).filter((item) => item !== key)
    checked.value = { ...checked.value, [request.id]: on ? [...current, key] : current }
  }

  const busy = ref<string[]>([])
  const failures = ref<Record<string, string>>({})
  const when = (iso: string) => new Date(iso).toLocaleString('pt-BR')
  const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR')
  const count = (total: number, one: string, many: string) => `${total} ${total === 1 ? one : many}`

  function fail(id: string, error: unknown) {
    let message = error instanceof Error ? error.message : String(error)
    if (error instanceof ApiError && error.code === 'widening_confirmation_required') {
      store.recomputed(id, ((error.details ?? {}) as { widenings?: IWideningRef[] }).widenings ?? [])
      // ⛔ A lista nova desmarca tudo: a pessoa confirma o que vê.
      checked.value = { ...checked.value, [id]: [] }
      message = 'As regras do agente mudaram desde que você abriu: a lista foi recalculada. Confira e confirme de novo.'
    } else if (error instanceof ApiError && error.status === 403) message = 'Só quem administra, entrando pela tela, aprova um pedido de permissão.'
    failures.value = { ...failures.value, [id]: message }
  }

  /** Devolve se deu certo: o lote conta os que passaram. */
  async function act(request: IPermissionRequest, work: () => Promise<void>): Promise<boolean> {
    busy.value = [...busy.value, request.id]
    const { [request.id]: _cleared, ...rest } = failures.value
    failures.value = rest
    try {
      await work()
      return true
    } catch (error) {
      fail(request.id, error)
      return false
    } finally {
      busy.value = busy.value.filter((id) => id !== request.id)
    }
  }

  /** ⛔ Só o pedido `secret` leva o valor, e ele é apagado da tela deu certo ou não. */
  async function approveRequest(request: IPermissionRequest) {
    const value = request.kind === 'secret' ? valueOf(request) : undefined
    try {
      await store.approve(request.id, keysOf(request), value)
    } finally {
      if (request.kind === 'secret') {
        const { [request.id]: _gone, ...rest } = values.value
        values.value = rest
      }
    }
  }
  const rejectRequest = async (request: IPermissionRequest) => void (await store.reject(request.id))
  const approve = (request: IPermissionRequest) => act(request, () => approveRequest(request))
  const reject = (request: IPermissionRequest) => act(request, () => rejectRequest(request))

  /**
   * EM LOTE: a lista é FOTOGRAFADA ao abrir a confirmação — o que chegar depois não entra, e cada aprovação manda as
   * chaves que a pessoa viu (se o servidor recalcular outra coisa, aquele item fica, com o erro nele).
   * - `restorations`: "Aprovar este lote" — só as restaurações;
   * - `new`: "Aprovar as N ampliações novas" — só as novas, cada uma listada pelo nome;
   * - `reject` / `discard`: recusar o lote (ou tudo), descartar os vencidos.
   */
  type TBulkMode = 'restorations' | 'new' | 'reject' | 'discard'
  type TBulkVerb = 'Aprovar' | 'Recusar' | 'Descartar'
  const VERB: Record<TBulkMode, TBulkVerb> = { restorations: 'Aprovar', new: 'Aprovar', reject: 'Recusar', discard: 'Descartar' }
  interface IBulk {
    mode: TBulkMode
    verb: TBulkVerb
    items: IPermissionRequest[]
    /** As variáveis secretas que a aprovação em lote deixou de fora. */
    skipped: number
  }
  const bulk = ref<IBulk>()
  const bulkBusy = ref(false)
  const outcome = ref<{ verb: TBulkVerb; done: number; failed: number }>()
  /** ⛔ A variável secreta nunca vai em lote: só vale com o valor digitado no item. */
  const approvable = (items: readonly IPermissionRequest[]) => items.filter((request) => request.kind !== 'secret')
  const restorations = (items: readonly IPermissionRequest[]) => approvable(items).filter(isRestoration)
  const fresh = (items: readonly IPermissionRequest[]) => approvable(items).filter((request) => !isRestoration(request))
  const DONE: Record<TBulkVerb, [string, string]> = { Aprovar: ['aprovado', 'aprovados'], Recusar: ['recusado', 'recusados'], Descartar: ['descartado', 'descartados'] }

  function openBulk(mode: TBulkMode, items: readonly IPermissionRequest[]) {
    const list = mode === 'restorations' ? restorations(items) : mode === 'new' ? fresh(items) : [...items]
    if (!list.length) return
    outcome.value = undefined
    const secrets = items.filter((request) => request.kind === 'secret').length
    bulk.value = { mode, verb: VERB[mode], items: list, skipped: mode === 'new' ? secrets : 0 }
  }
  function closeBulk() {
    if (!bulkBusy.value) bulk.value = undefined
  }
  const bulkTitle = computed(() => {
    const run = bulk.value
    if (!run) return ''
    if (run.mode === 'restorations') return `Aprovar ${count(run.items.length, 'restauração', 'restaurações')} deste lote?`
    if (run.mode === 'new') return `Aprovar ${count(run.items.length, 'ampliação nova', 'ampliações novas')}?`
    return `${run.verb} ${count(run.items.length, 'pedido', 'pedidos')}?`
  })
  const bulkMessage = computed(() => {
    const mode = bulk.value?.mode
    if (mode === 'restorations') return 'Só o que o agente alvo já teve numa versão anterior. As ampliações novas deste lote ficam esperando, item a item.'
    if (mode === 'new') return '⚠️ O agente alvo NUNCA teve nada disto. Confira cada nome: é exatamente isto que passa a valer.'
    return 'Nada desta lista passa a valer.'
  })

  /** ⚖️ Um por vez: cada aprovação recalcula no servidor sobre o que o anterior gravou, e a falha de um não derruba os outros. */
  async function runBulk() {
    const run = bulk.value
    if (!run || bulkBusy.value) return
    bulkBusy.value = true
    let failed = 0
    try {
      for (const request of run.items) if (!(await act(request, () => (run.verb === 'Aprovar' ? approveRequest(request) : rejectRequest(request))))) failed += 1
    } finally {
      bulkBusy.value = false
      bulk.value = undefined
    }
    outcome.value = { verb: run.verb, done: run.items.length - failed, failed }
  }
</script>

<template>
  <div v-if="!projects.managesAny" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra um projeto vê as notificações.</p>
  </div>

  <div v-else class="h-full overflow-y-auto px-4 py-5" data-test="notifications">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header>
        <h1 class="text-xl font-semibold">Notificações</h1>
        <p class="text-xs text-zinc-500">
          Pedidos de permissão dos agentes, um lote por chamada. Nada vale até você aprovar aqui; o que só restringia já foi aplicado.
        </p>
      </header>

      <div v-if="expired.length" class="flex gap-1 border-b border-zinc-800" role="tablist">
        <button
          v-for="option in [
            { id: 'pending' as const, label: 'Pendentes', total: pending.length },
            { id: 'expired' as const, label: 'Vencidos', total: expired.length },
          ]"
          :key="option.id"
          type="button"
          role="tab"
          :aria-selected="showing === option.id"
          :data-test="`tab-${option.id}`"
          class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
          :class="showing === option.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
          @click="tab = option.id"
        >
          {{ option.label }}
          <span class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">{{ option.total }}</span>
        </button>
      </div>

      <p v-if="outcome" class="rounded-xl border border-zinc-800 px-3 py-2 text-sm" :class="outcome.failed ? 'text-amber-300' : 'text-success-300'" data-test="bulk-outcome">
        {{ count(outcome.done, ...DONE[outcome.verb]) }}.
        <template v-if="outcome.failed">{{ count(outcome.failed, 'não passou', 'não passaram') }}: o motivo está em cada um.</template>
      </p>

      <p v-if="loading" class="text-sm text-zinc-500">Carregando…</p>

      <template v-else-if="showing === 'pending'">
        <p v-if="!pending.length" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500" data-test="notifications-empty">
          Nada esperando por você.
        </p>

        <template v-else>
          <div class="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 px-3 py-2" data-test="bulk-bar">
            <p class="text-sm text-zinc-200" data-test="pending-total">
              {{ count(pending.length, 'pedido', 'pedidos') }}
              <span class="text-zinc-500">em {{ count(batches.length, 'lote', 'lotes') }}</span>
            </p>
            <span class="flex-1" />
            <button type="button" class="btn btn-ghost" :disabled="bulkBusy" data-test="reject-all" @click="openBulk('reject', pending)">Recusar todos</button>
          </div>

          <section
            v-for="batch in visible"
            :key="batch.key || 'none'"
            class="flex flex-col gap-2 rounded-xl border border-zinc-800 px-3 py-3"
            :data-batch="batch.key || 'none'"
            data-test="request-batch"
          >
            <header class="flex flex-col gap-1" data-test="batch-header">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-sm font-medium text-zinc-100" data-test="batch-title">
                  <template v-if="!batch.key">Sem origem</template>
                  <template v-else-if="batch.head.requestedBy.agentId">
                    Pedido pelo agente
                    <code>{{ batch.head.requestedBy.agentId }}</code>
                  </template>
                  <template v-else>Pedido pela conta {{ batch.head.requestedBy.by }}</template>
                </h2>
                <span class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400" data-test="batch-count">{{ count(batch.items.length, 'item', 'itens') }}</span>
                <span class="flex-1" />
                <span class="text-[11px] text-zinc-500">{{ when(batch.createdAt) }}</span>
              </div>
              <p v-if="!batch.key" class="text-xs text-zinc-500">Pedidos de antes do lote: cada um diz quem pediu e por quê.</p>
              <template v-else>
                <p class="text-xs text-zinc-400">
                  Para {{ batch.targets.join(', ') }}
                  <template v-if="batch.head.requestedBy.conversationId">
                    · na
                    <RouterLink :to="`/c/${batch.head.requestedBy.conversationId}`" class="underline hover:text-zinc-200" data-test="request-conversation">conversa</RouterLink>
                  </template>
                  · com a conta {{ batch.head.requestedBy.by }}
                </p>
                <p class="text-sm whitespace-pre-wrap text-zinc-100" data-test="request-reason">{{ batch.head.reason }}</p>
              </template>
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  :disabled="!restorations(batch.items).length || bulkBusy"
                  data-test="batch-approve"
                  @click="openBulk('restorations', batch.items)"
                >
                  Aprovar este lote ({{ count(restorations(batch.items).length, 'restauração', 'restaurações') }})
                </button>
                <button
                  v-if="fresh(batch.items).length"
                  type="button"
                  class="btn btn-sm btn-secondary"
                  :disabled="bulkBusy"
                  data-test="batch-approve-new"
                  @click="openBulk('new', batch.items)"
                >
                  {{ fresh(batch.items).length === 1 ? 'Aprovar a ampliação nova deste lote' : `Aprovar as ${fresh(batch.items).length} ampliações novas deste lote` }}
                </button>
                <button type="button" class="btn btn-sm btn-ghost" :disabled="bulkBusy" data-test="batch-reject" @click="openBulk('reject', batch.items)">Recusar o lote</button>
              </div>
            </header>

            <template v-for="request in batch.shown" :key="request.id">
              <div v-if="!batch.key" class="flex flex-col gap-1 pt-1" data-test="request-ask">
                <p class="text-xs text-zinc-400">
                  <span class="font-medium text-zinc-200">{{ targetTitle(request) }}.</span>
                  <template v-if="request.requestedBy.agentId">
                    Pedido pelo agente
                    <code>{{ request.requestedBy.agentId }}</code>
                  </template>
                  <template v-else>Pedido</template>
                  <template v-if="request.requestedBy.conversationId">
                    na
                    <RouterLink :to="`/c/${request.requestedBy.conversationId}`" class="underline hover:text-zinc-200" data-test="request-conversation">conversa</RouterLink>
                  </template>
                  com a conta {{ request.requestedBy.by }}, em {{ when(request.createdAt) }}.
                </p>
                <p class="text-sm whitespace-pre-wrap text-zinc-100" data-test="request-reason">{{ request.reason }}</p>
              </div>

              <article class="flex flex-col gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5" :data-request="request.id" data-test="request-item">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300" data-test="request-kind">{{ kindLabel(request) }}</span>
                  <span
                    class="rounded-full px-2 py-0.5 text-[11px]"
                    :class="isRestoration(request) ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'"
                    :title="isRestoration(request) && request.restoredRevision ? `o agente já tinha isso na revisão ${request.restoredRevision}` : undefined"
                    data-test="request-origin"
                    >{{ originLabel(request) }}</span
                  >
                  <span v-if="request.kind === 'agent-local'" class="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-300" data-test="request-local">só nesta máquina</span>
                  <span class="flex-1" />
                  <span class="text-[11px] text-zinc-500">vence em {{ day(request.expiresAt) }}</span>
                </div>
                <div v-if="request.secret" class="flex flex-col gap-0.5" data-test="secret-request">
                  <p class="text-sm text-zinc-100">{{ secretLine(request.secret) }}</p>
                  <p v-if="secretProjectLine(request.secret, projectNameOf)" class="text-xs text-amber-300" data-test="secret-project">
                    {{ secretProjectLine(request.secret, projectNameOf) }}
                  </p>
                  <p v-if="request.secret.description" class="text-xs text-zinc-400" data-test="secret-description">{{ request.secret.description }}</p>
                </div>
                <ul class="flex flex-col gap-0.5 text-xs text-zinc-300">
                  <li v-for="rule in request.add" :key="`+${rule.category}:${rule.pattern}`">{{ ruleLine(rule, 'add') }}</li>
                  <li v-for="rule in request.remove" :key="`-${rule.category}:${rule.pattern}`">{{ ruleLine(rule, 'remove') }}</li>
                  <li v-for="(value, field) in request.patch ?? {}" :key="`patch:${field}`" class="truncate" :title="patchLine(String(field), value)">
                    {{ patchLine(String(field), value) }}
                  </li>
                  <li v-if="request.entries" data-test="request-entries">{{ requestEntriesLine(request, request.entries) }}</li>
                </ul>
                <p v-if="request.changed" class="text-xs text-amber-300">
                  {{ request.kind === 'agent-patch' || request.kind === 'agent-local' ? 'O agente mudou' : 'As regras mudaram' }} desde o pedido: a lista abaixo foi recalculada sobre o
                  que vale agora.
                </p>

                <div v-if="request.widenings.length" class="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5" data-test="widening-confirm">
                  <p class="text-xs text-amber-200/80">Esta troca amplia acesso. Confirme cada item: sem todos marcados, nada é gravado.</p>
                  <ul class="flex flex-col gap-1.5">
                    <li v-for="item in request.widenings" :key="item.key">
                      <label class="flex items-start gap-2 text-sm text-zinc-100">
                        <input
                          type="checkbox"
                          class="mt-0.5 accent-amber-500"
                          :checked="isChecked(request, item.key)"
                          :data-key="item.key"
                          @change="toggleKey(request, item.key, ($event.target as HTMLInputElement).checked)"
                        />
                        <span class="min-w-0">
                          {{ item.description }}
                          <code class="block truncate text-[11px] text-zinc-500" :title="item.key">{{ item.key }}</code>
                        </span>
                      </label>
                    </li>
                  </ul>
                  <label v-if="request.kind === 'secret'" class="flex flex-col gap-1 text-sm text-zinc-200">
                    Valor da variável
                    <input
                      type="password"
                      autocomplete="new-password"
                      class="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono font-normal text-zinc-100 outline-none focus:border-emerald-500/60"
                      :value="valueOf(request)"
                      data-test="secret-value"
                      @input="values = { ...values, [request.id]: ($event.target as HTMLInputElement).value }"
                    />
                    <span class="text-xs text-zinc-500">Só você digita: o valor vai criptografado e não aparece de novo, nem aqui.</span>
                  </label>
                </div>
                <p v-else class="text-xs text-zinc-400">Com as regras de agora, isto não amplia mais nada.</p>
                <div class="flex gap-2">
                  <button type="button" class="btn btn-sm btn-primary" :disabled="!ready(request) || busy.includes(request.id)" data-test="item-approve" @click="approve(request)">
                    {{ busy.includes(request.id) ? 'Gravando…' : 'Aprovar' }}
                  </button>
                  <button type="button" class="btn btn-sm btn-ghost" :disabled="busy.includes(request.id)" data-test="item-reject" @click="reject(request)">Recusar</button>
                </div>
                <p v-if="failures[request.id]" class="text-sm text-rose-300" data-test="request-error">{{ failures[request.id] }}</p>
              </article>
            </template>

            <ListPager
              :model-value="batch.page"
              :pages="batch.pages"
              :total="batch.items.length"
              :size="PAGE_SIZE"
              @update:model-value="(page: number) => (itemPages = { ...itemPages, [batch.key]: page })"
            />
          </section>
          <ListPager v-model="batchPage.page.value" :pages="batchPage.pages.value" :total="batchPage.total.value" :size="batchPage.size" />
        </template>
      </template>

      <section v-else class="flex flex-col gap-2" data-test="expired-section">
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-xs text-zinc-500">Passaram do prazo sem decisão: não podem mais ser aprovados. O agente precisa pedir de novo.</p>
          <span class="flex-1" />
          <button v-if="expired.length > 1" type="button" class="btn btn-sm btn-ghost" :disabled="bulkBusy" data-test="discard-all" @click="openBulk('discard', expired)">
            Descartar todos ({{ expired.length }})
          </button>
        </div>
        <article
          v-for="request in expiredPage.items.value"
          :key="request.id"
          class="flex flex-col gap-2 rounded-xl border border-zinc-800 px-3 py-3"
          :data-request="request.id"
          data-test="expired-item"
        >
          <p class="text-xs text-zinc-400">
            <span class="font-medium text-zinc-200">{{ targetTitle(request) }}.</span>
            <template v-if="request.requestedBy.agentId">
              Pedido pelo agente
              <code>{{ request.requestedBy.agentId }}</code>
            </template>
            <template v-else>Pedido</template>
            <template v-if="request.requestedBy.conversationId">
              na
              <RouterLink :to="`/c/${request.requestedBy.conversationId}`" class="underline hover:text-zinc-200">conversa</RouterLink>
            </template>
            com a conta {{ request.requestedBy.by }}, em {{ when(request.createdAt) }}.
          </p>
          <p class="text-sm whitespace-pre-wrap text-zinc-100">{{ request.reason }}</p>
          <p class="text-xs text-zinc-300" data-test="expired-summary">{{ itemSummary(request) }}</p>
          <p class="text-xs text-amber-300">Vencido em {{ when(request.expiresAt) }}.</p>
          <div>
            <button type="button" class="btn btn-sm btn-ghost" :disabled="busy.includes(request.id)" data-test="request-discard" @click="reject(request)">Descartar</button>
          </div>
          <p v-if="failures[request.id]" class="text-sm text-rose-300" data-test="request-error">{{ failures[request.id] }}</p>
        </article>
        <ListPager v-model="expiredPage.page.value" :pages="expiredPage.pages.value" :total="expiredPage.total.value" :size="expiredPage.size" />
      </section>
    </section>

    <ConfirmDialog
      :open="!!bulk"
      :title="bulkTitle"
      :message="bulkMessage"
      :action="bulk?.verb"
      :tone="bulk?.verb === 'Aprovar' ? 'neutral' : 'danger'"
      :busy="bulkBusy"
      wide
      @confirm="runBulk"
      @cancel="closeBulk"
    >
      <ul class="mt-3 flex max-h-[45vh] list-disc flex-col gap-0.5 overflow-y-auto rounded-lg border border-zinc-800 p-3 pl-7 text-xs text-zinc-300" data-test="bulk-list">
        <li v-for="request in bulk?.items ?? []" :key="request.id" :data-request="request.id">
          <span class="text-zinc-500">{{ targetTitle(request) }}:</span>
          {{ itemSummary(request) }}
          <span v-if="bulk?.mode !== 'restorations' && bulk?.verb === 'Aprovar'" class="text-rose-300">({{ originLabel(request) }})</span>
        </li>
      </ul>
      <p v-if="bulk?.skipped" class="mt-2 text-xs text-amber-300" data-test="bulk-skipped">
        {{ count(bulk.skipped, 'variável secreta fica de fora: ela', 'variáveis secretas ficam de fora: cada uma') }} só vale com o valor digitado no próprio pedido.
      </p>
    </ConfirmDialog>
  </div>
</template>
