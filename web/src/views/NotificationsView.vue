<script setup lang="ts">
  import { computed, ref } from 'vue'
  import ConfirmDialog from '@/components/ConfirmDialog.vue'
  import { ApiError } from '@/lib/api'
  import type { IWideningRef } from '@/lib/catalogHistory'
  import { type IPermissionRequest, entriesLine, patchLine, ruleLine, secretLine, secretProjectLine } from '@/lib/permissionRequests'
  import { useResource } from '@/composables/useResource'
  import { useProjectsStore } from '@/stores/projects'
  import { usePermissionRequestsStore } from '@/stores/permissionRequests'

  /**
   * As NOTIFICAÇÕES (só quem administra projeto): os pedidos de permissão abertos dos agentes (o servidor devolve os dos projetos de que a pessoa é admin), num lugar só. Cada
   * pedido é UM item (uma regra, um campo, uma ferramenta); os da mesma chamada do agente dividem o `batchId` e viram um
   * lote, com o motivo e a origem no cabeçalho. ⛔ Aprovar manda as chaves de TODAS as ampliações do item e só liga com
   * todas marcadas — igual à `WideningConfirm`; "aprovar marcados" nunca pula isso: item com caixa faltando não conta.
   * ⚖️ Os pedidos vêm da lista de todos da store (a mesma do selo), que anda sozinha com o `catalog.changed`.
   */
  const projects = useProjectsStore()
  const projectNameOf = (id: string) => projects.list.find((project) => project.id === id)?.name
  const store = usePermissionRequestsStore()
  const { data, loading } = useResource(store.lists, () => (projects.managesAny ? '' : undefined))

  interface IGroup {
    key: string
    batchId?: string
    items: IPermissionRequest[]
  }

  const newestFirst = (a: IPermissionRequest, b: IPermissionRequest) => b.createdAt.localeCompare(a.createdAt)
  const pending = computed(() => (data.value ?? []).filter((request) => request.status === 'pending').sort(newestFirst))
  const expired = computed(() => (data.value ?? []).filter((request) => request.status === 'expired').sort(newestFirst))

  /** Por `batchId` (sem ele, o pedido é o próprio lote); a ordem é a do item mais novo de cada lote. */
  const groups = computed<IGroup[]>(() => {
    const byKey = new Map<string, IGroup>()
    for (const request of pending.value) {
      const key = request.batchId ? `batch:${request.batchId}` : `solo:${request.id}`
      const group = byKey.get(key) ?? { key, batchId: request.batchId, items: [] }
      group.items.push(request)
      byKey.set(key, group)
    }
    return [...byKey.values()]
  })

  // As caixas: por pedido, as chaves de ampliação marcadas; e os pedidos sem ampliação que a pessoa escolheu.
  const checked = ref<Record<string, string[]>>({})
  const selected = ref<string[]>([])
  /** ⛔ O valor digitado de cada pedido `secret`: só existe aqui, até aprovar (aí é apagado), e nunca vem do servidor. */
  const values = ref<Record<string, string>>({})
  const valueOf = (request: IPermissionRequest) => values.value[request.id] ?? ''

  const keysOf = (request: IPermissionRequest) => request.widenings.map((item) => item.key)
  const isChecked = (request: IPermissionRequest, key: string) => (checked.value[request.id] ?? []).includes(key)
  /**
   * Marcado = pronto para aprovar em lote: todas as ampliações marcadas, ou (sem ampliação) escolhido. ⛔ Pedido `secret`
   * também exige o valor digitado: sem ele, "aprovar marcados" o pula.
   */
  function marked(request: IPermissionRequest): boolean {
    if (request.kind === 'secret' && !valueOf(request)) return false
    if (!request.widenings.length) return selected.value.includes(request.id)
    return keysOf(request).every((key) => isChecked(request, key))
  }

  function setItem(request: IPermissionRequest, on: boolean) {
    if (request.widenings.length) checked.value = { ...checked.value, [request.id]: on ? keysOf(request) : [] }
    else selected.value = on ? [...new Set([...selected.value, request.id])] : selected.value.filter((id) => id !== request.id)
  }

  function toggleKey(request: IPermissionRequest, key: string, on: boolean) {
    const current = (checked.value[request.id] ?? []).filter((item) => item !== key)
    checked.value = { ...checked.value, [request.id]: on ? [...current, key] : current }
  }

  const allMarked = (items: IPermissionRequest[]) => items.length > 0 && items.every(marked)
  function toggleAll(items: IPermissionRequest[]) {
    const on = !allMarked(items)
    for (const request of items) setItem(request, on)
  }

  const markedItems = computed(() => pending.value.filter(marked))

  const busy = ref<string[]>([])
  const bulkBusy = ref(false)
  const confirmOpen = ref(false)
  const failures = ref<Record<string, string>>({})
  const when = (iso: string) => new Date(iso).toLocaleString('pt-BR')
  const SECRET_SCOPE = { agent: 'agente', skill: 'skill', command: 'command' } as const
  const target = (request: IPermissionRequest) =>
    request.kind === 'secret' && request.secret
      ? `${SECRET_SCOPE[request.secret.scope] ?? request.secret.scope} ${request.secret.scopeId}`
      : request.kind === 'project-rules'
        ? `projeto ${request.projectName ?? request.projectId ?? ''}`
        : `agente ${request.agentName ?? request.agentId ?? ''}`

  function fail(id: string, error: unknown) {
    let message = error instanceof Error ? error.message : String(error)
    if (error instanceof ApiError && error.code === 'widening_confirmation_required') {
      store.recomputed(id, ((error.details ?? {}) as { widenings?: IWideningRef[] }).widenings ?? [])
      // ⛔ A lista nova desmarca tudo: a pessoa confirma o que vê.
      checked.value = { ...checked.value, [id]: [] }
      selected.value = selected.value.filter((item) => item !== id)
      message = 'As regras do agente mudaram desde que você abriu: a lista foi recalculada. Confira e confirme de novo.'
    } else if (error instanceof ApiError && error.status === 403) message = 'Só quem administra, entrando pela tela, aprova um pedido de permissão.'
    failures.value = { ...failures.value, [id]: message }
  }

  async function act(request: IPermissionRequest, work: () => Promise<void>) {
    busy.value = [...busy.value, request.id]
    const { [request.id]: _cleared, ...rest } = failures.value
    failures.value = rest
    try {
      await work()
    } catch (error) {
      fail(request.id, error)
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
  const approve = (request: IPermissionRequest) => act(request, () => approveRequest(request))
  const reject = (request: IPermissionRequest) =>
    act(request, async () => {
      await store.reject(request.id)
    })

  /** ⚖️ Um por vez: cada aprovação recalcula no servidor sobre o que o anterior gravou, e a falha de um não derruba os outros. */
  async function eachMarked(work: (request: IPermissionRequest) => Promise<void>) {
    const todo = [...markedItems.value]
    bulkBusy.value = true
    try {
      for (const request of todo) await act(request, () => work(request))
    } finally {
      bulkBusy.value = false
    }
  }

  async function approveMarked() {
    confirmOpen.value = false
    await eachMarked(approveRequest)
  }
  const rejectMarked = () => eachMarked(async (request) => void (await store.reject(request.id)))
</script>

<template>
  <div v-if="!projects.managesAny" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra um projeto vê as notificações.</p>
  </div>

  <div v-else class="h-full overflow-y-auto px-4 py-5" data-test="notifications">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header>
        <h1 class="text-xl font-semibold">Notificações</h1>
        <p class="text-xs text-zinc-500">Pedidos de permissão dos agentes. Nada vale até você aprovar aqui; o que só restringia já foi aplicado.</p>
      </header>

      <p v-if="loading" class="text-sm text-zinc-500">Carregando…</p>
      <p
        v-else-if="!pending.length && !expired.length"
        class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500"
        data-test="notifications-empty"
      >
        Nada esperando por você.
      </p>

      <template v-if="pending.length">
        <div class="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 px-3 py-2" data-test="bulk-bar">
          <label class="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" class="accent-amber-500" :checked="allMarked(pending)" data-test="select-all" @change="toggleAll(pending)" />
            Marcar todos
          </label>
          <span class="flex-1" />
          <button type="button" class="btn btn-primary" :disabled="!markedItems.length || bulkBusy" data-test="approve-selected" @click="confirmOpen = true">
            Aprovar marcados ({{ markedItems.length }})
          </button>
          <button type="button" class="btn btn-ghost" :disabled="!markedItems.length || bulkBusy" data-test="reject-selected" @click="rejectMarked">
            Recusar marcados ({{ markedItems.length }})
          </button>
        </div>

        <section v-for="group in groups" :key="group.key" class="flex flex-col gap-2 rounded-xl border border-zinc-800 px-3 py-3" :data-group="group.key" data-test="request-group">
          <header class="flex flex-col gap-1">
            <p class="text-xs text-zinc-400">
              <template v-if="group.items[0].requestedBy.agentId">
                Pedido pelo agente
                <code>{{ group.items[0].requestedBy.agentId }}</code>
              </template>
              <template v-else>Pedido</template>
              <template v-if="group.items[0].requestedBy.conversationId">
                na
                <RouterLink :to="`/c/${group.items[0].requestedBy.conversationId}`" class="underline hover:text-zinc-200" data-test="request-conversation">conversa</RouterLink>
              </template>
              com a conta {{ group.items[0].requestedBy.by }}, em {{ when(group.items[0].createdAt) }}.
              <span class="text-zinc-500">Alvo: {{ target(group.items[0]) }}.</span>
            </p>
            <p class="text-sm whitespace-pre-wrap text-zinc-100" data-test="request-reason">{{ group.items[0].reason }}</p>
            <label class="flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" class="accent-amber-500" :checked="allMarked(group.items)" data-test="group-toggle" @change="toggleAll(group.items)" />
              Marcar todos do lote
              <template v-if="group.items.length > 1">({{ group.items.length }})</template>
            </label>
          </header>

          <article
            v-for="request in group.items"
            :key="request.id"
            class="flex flex-col gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5"
            :data-request="request.id"
            data-test="request-item"
          >
            <div v-if="request.secret" class="flex flex-col gap-0.5" data-test="secret-request">
              <p class="text-sm text-zinc-100">{{ secretLine(request.secret) }}</p>
              <p v-if="secretProjectLine(request.secret, projectNameOf)" class="text-xs text-amber-300" data-test="secret-project">{{ secretProjectLine(request.secret, projectNameOf) }}</p>
              <p v-if="request.secret.description" class="text-xs text-zinc-400" data-test="secret-description">{{ request.secret.description }}</p>
            </div>
            <ul class="flex flex-col gap-0.5 text-xs text-zinc-300">
              <li v-for="rule in request.add" :key="`+${rule.category}:${rule.pattern}`">{{ ruleLine(rule, 'add') }}</li>
              <li v-for="rule in request.remove" :key="`-${rule.category}:${rule.pattern}`">{{ ruleLine(rule, 'remove') }}</li>
              <li v-for="(value, field) in request.patch ?? {}" :key="`patch:${field}`" class="truncate" :title="patchLine(String(field), value)">
                {{ patchLine(String(field), value) }}
              </li>
              <li v-if="request.entries" data-test="request-entries">{{ entriesLine(request.entries) }}</li>
            </ul>
            <p v-if="request.changed" class="text-xs text-amber-300">
              {{ request.kind === 'agent-patch' ? 'O agente mudou' : 'As regras mudaram' }} desde o pedido: a lista abaixo foi recalculada sobre o que vale agora.
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
              <div class="flex gap-2">
                <button type="button" class="btn btn-primary" :disabled="!marked(request) || busy.includes(request.id)" data-test="item-approve" @click="approve(request)">
                  {{ busy.includes(request.id) ? 'Gravando…' : 'Aprovar' }}
                </button>
                <button type="button" class="btn btn-ghost" :disabled="busy.includes(request.id)" data-test="item-reject" @click="reject(request)">Recusar</button>
              </div>
            </div>
            <div v-else class="flex flex-col gap-2">
              <p class="text-xs text-zinc-400">Com as regras de agora, isto não amplia mais nada.</p>
              <label class="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" class="accent-amber-500" :checked="marked(request)" data-test="item-select" @change="setItem(request, !marked(request))" />
                Marcar
              </label>
              <div class="flex gap-2">
                <button type="button" class="btn btn-primary" :disabled="busy.includes(request.id)" data-test="item-approve" @click="approve(request)">Aprovar</button>
                <button type="button" class="btn btn-ghost" :disabled="busy.includes(request.id)" data-test="item-reject" @click="reject(request)">Recusar</button>
              </div>
            </div>
            <p class="text-[11px] text-zinc-500">Vence em {{ when(request.expiresAt) }}.</p>
            <p v-if="failures[request.id]" class="text-sm text-rose-300" data-test="request-error">{{ failures[request.id] }}</p>
          </article>
        </section>
      </template>

      <section v-if="expired.length" class="flex flex-col gap-2" data-test="expired-section">
        <h2 class="text-sm font-medium text-zinc-200">Vencidos ({{ expired.length }})</h2>
        <article
          v-for="request in expired"
          :key="request.id"
          class="flex flex-col gap-2 rounded-xl border border-zinc-800 px-3 py-3"
          :data-request="request.id"
          data-test="expired-item"
        >
          <p class="text-xs text-zinc-400">
            <template v-if="request.requestedBy.agentId">
              Pedido pelo agente
              <code>{{ request.requestedBy.agentId }}</code>
            </template>
            <template v-if="request.requestedBy.conversationId">
              na
              <RouterLink :to="`/c/${request.requestedBy.conversationId}`" class="underline hover:text-zinc-200">conversa</RouterLink>
            </template>
            com a conta {{ request.requestedBy.by }}, em {{ when(request.createdAt) }}.
            <span class="text-zinc-500">Alvo: {{ target(request) }}.</span>
          </p>
          <p class="text-sm whitespace-pre-wrap text-zinc-100">{{ request.reason }}</p>
          <ul class="flex flex-col gap-0.5 text-xs text-zinc-300">
            <li v-for="rule in request.add" :key="`+${rule.category}:${rule.pattern}`">{{ ruleLine(rule, 'add') }}</li>
            <li v-for="rule in request.remove" :key="`-${rule.category}:${rule.pattern}`">{{ ruleLine(rule, 'remove') }}</li>
            <li v-for="(value, field) in request.patch ?? {}" :key="`patch:${field}`" class="truncate" :title="patchLine(String(field), value)">
              {{ patchLine(String(field), value) }}
            </li>
            <li v-if="request.entries" data-test="request-entries">{{ entriesLine(request.entries) }}</li>
          </ul>
          <p class="text-xs text-amber-300">Vencido em {{ when(request.expiresAt) }}: não pode mais ser aprovado. O agente precisa pedir de novo.</p>
          <div>
            <button type="button" class="btn btn-ghost" :disabled="busy.includes(request.id)" data-test="request-discard" @click="reject(request)">Descartar</button>
          </div>
          <p v-if="failures[request.id]" class="text-sm text-rose-300" data-test="request-error">{{ failures[request.id] }}</p>
        </article>
      </section>
    </section>

    <ConfirmDialog
      :open="confirmOpen"
      :title="`Aprovar ${markedItems.length} pedido${markedItems.length > 1 ? 's' : ''}?`"
      message="Isto amplia o acesso dos agentes listados."
      action="Aprovar"
      tone="neutral"
      :busy="bulkBusy"
      @confirm="approveMarked"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
