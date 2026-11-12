<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { ApiError } from '@/lib/api'
  import type { IWideningRef } from '@/lib/catalogHistory'
  import { type IPermissionRequest, patchLine, requestEntriesLine, requestsKey, ruleLine, secretLine, secretProjectLine } from '@/lib/permissionRequests'
  import type { IPermissionRule } from '@/lib/types'
  import { usePaged } from '@/composables/usePaged'
  import { useResource } from '@/composables/useResource'
  import { useProjectsStore } from '@/stores/projects'
  import { usePermissionRequestsStore } from '@/stores/permissionRequests'
  import ListPager from './ListPager.vue'
  import WideningConfirm from './WideningConfirm.vue'

  /**
   * OS PEDIDOS PENDENTES de um agente (guia Permissões) ou das regras de um projeto (tela Permissões): o que um agente
   * pediu e não vale até alguém daqui confirmar. ⛔ Aprovar pede cada ampliação marcada (`WideningConfirm`) e só passa
   * pela sessão da tela — o servidor recusa o resto.
   */
  const props = defineProps<{ agentId?: string; projectId?: string }>()
  const emit = defineEmits<{ approved: [request: IPermissionRequest, permissions: IPermissionRule[] | undefined] }>()

  const store = usePermissionRequestsStore()
  const projects = useProjectsStore()
  const projectNameOf = (id: string) => projects.list.find((project) => project.id === id)?.name
  const { data } = useResource(store.lists, () => (props.agentId || props.projectId ? requestsKey(props) : undefined))
  const requests = computed(() => data.value ?? [])
  const pending = computed(() => requests.value.filter((request) => request.status === 'pending').length)
  // Um pedido decidido sai da lista: quem fica continua na página em que estava.
  const paged = usePaged(requests, { by: (request) => request.id })

  const busy = ref<string>()
  const failures = ref<Record<string, string>>({})
  const when = (iso: string) => new Date(iso).toLocaleString('pt-BR')

  function fail(id: string, error: unknown) {
    let message = error instanceof Error ? error.message : String(error)
    if (error instanceof ApiError && error.code === 'widening_confirmation_required') {
      store.recomputed(id, ((error.details ?? {}) as { widenings?: IWideningRef[] }).widenings ?? [])
      message = 'As regras do agente mudaram desde que você abriu: a lista foi recalculada. Confira e confirme de novo.'
    } else if (error instanceof ApiError && error.status === 403) message = 'Só quem administra, entrando pela tela, aprova um pedido de permissão.'
    failures.value = { ...failures.value, [id]: message }
  }

  async function act(request: IPermissionRequest, work: () => Promise<void>) {
    busy.value = request.id
    const { [request.id]: _cleared, ...rest } = failures.value
    failures.value = rest
    try {
      await work()
    } catch (error) {
      fail(request.id, error)
    } finally {
      busy.value = undefined
    }
  }

  /** ⛔ O valor digitado de um pedido `secret`: só vive aqui, até aprovar (deu certo ou não, é apagado). */
  const values = ref<Record<string, string>>({})
  const valueOf = (request: IPermissionRequest) => values.value[request.id] ?? ''
  /** As caixas do pedido `secret` (`<id>|<chave>`): a `WideningConfirm` não leva o campo do valor, então este pedido tem a sua. */
  const secretChecked = ref<Set<string>>(new Set())
  function toggleSecret(request: IPermissionRequest, key: string, on: boolean) {
    const next = new Set(secretChecked.value)
    if (on) next.add(`${request.id}|${key}`)
    else next.delete(`${request.id}|${key}`)
    secretChecked.value = next
  }
  /** ⛔ Aprovar liga só com TODAS as caixas marcadas E o valor digitado. */
  const secretReady = (request: IPermissionRequest) =>
    request.widenings.length > 0 && !!valueOf(request) && request.widenings.every((item) => secretChecked.value.has(`${request.id}|${item.key}`))
  const approve = (request: IPermissionRequest, keys: string[]) =>
    act(request, async () => {
      try {
        const result = await store.approve(request.id, keys, request.kind === 'secret' ? valueOf(request) : undefined)
        emit('approved', result.request, result.permissions)
      } finally {
        if (request.kind === 'secret') {
          const { [request.id]: _gone, ...rest } = values.value
          values.value = rest
        }
      }
    })
  const reject = (request: IPermissionRequest) =>
    act(request, async () => {
      await store.reject(request.id)
    })
</script>

<template>
  <section v-if="requests.length" class="flex flex-col gap-3" data-test="permission-requests">
    <div>
      <h3 class="text-sm font-medium text-zinc-200">Pedidos pendentes ({{ pending }})</h3>
      <p class="text-xs text-zinc-500">
        Um agente pediu para ampliar o acesso {{ projectId ? 'dos agentes deste projeto' : 'deste agente' }}. Nada disto vale até você aprovar aqui; o que só restringia já foi
        aplicado.
      </p>
    </div>
    <article v-for="request in paged.items.value" :key="request.id" class="flex flex-col gap-2 rounded-xl border border-zinc-800 px-3 py-3" :data-request="request.id">
      <p class="text-xs text-zinc-400">
        Pedido
        <template v-if="request.requestedBy.agentId">
          pelo agente
          <code>{{ request.requestedBy.agentId }}</code>
        </template>
        <template v-if="request.requestedBy.conversationId">
          na
          <RouterLink :to="`/c/${request.requestedBy.conversationId}`" class="underline hover:text-zinc-200" data-test="request-conversation">conversa</RouterLink>
        </template>
        com a conta {{ request.requestedBy.by }}, em {{ when(request.createdAt) }}.
      </p>
      <p class="text-sm whitespace-pre-wrap text-zinc-100" data-test="request-reason">{{ request.reason }}</p>
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
        <li v-if="request.entries" data-test="request-entries">{{ requestEntriesLine(request, request.entries) }}</li>
      </ul>
      <p v-if="request.changed" class="text-xs text-amber-300">
        {{ request.kind === 'agent-patch' || request.kind === 'agent-local' ? 'O agente mudou' : 'As regras mudaram' }} desde o pedido: a lista abaixo foi recalculada sobre o que vale agora.
      </p>

      <template v-if="request.status === 'expired'">
        <p class="text-xs text-amber-300" data-test="request-expired">Vencido em {{ when(request.expiresAt) }}: não pode mais ser aprovado. O agente precisa pedir de novo.</p>
        <div>
          <button type="button" class="btn btn-ghost" :disabled="busy === request.id" data-test="request-discard" @click="reject(request)">Descartar</button>
        </div>
      </template>
      <section v-else-if="request.kind === 'secret'" class="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3" data-test="secret-confirm">
        <p class="text-xs text-amber-200/80">Esta variável dá ao agente um segredo para usar nos comandos. Confirme e digite o valor: sem os dois, nada é gravado.</p>
        <label v-for="item in request.widenings" :key="item.key" class="flex items-start gap-2 text-sm text-zinc-100">
          <input
            type="checkbox"
            class="mt-0.5 accent-amber-500"
            :checked="secretChecked.has(`${request.id}|${item.key}`)"
            :data-key="item.key"
            @change="toggleSecret(request, item.key, ($event.target as HTMLInputElement).checked)"
          />
          <span class="min-w-0">
            {{ item.description }}
            <code class="block truncate text-[11px] text-zinc-500" :title="item.key">{{ item.key }}</code>
          </span>
        </label>
        <label class="flex flex-col gap-1 text-sm text-zinc-200">
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
          <button
            type="button"
            class="btn btn-primary"
            :disabled="!secretReady(request) || busy === request.id"
            data-test="secret-approve"
            @click="approve(request, request.widenings.map((item) => item.key))"
          >
            {{ busy === request.id ? 'Gravando…' : 'Aprovar' }}
          </button>
          <button type="button" class="btn btn-ghost" :disabled="busy === request.id" data-test="secret-reject" @click="reject(request)">Recusar</button>
        </div>
      </section>
      <WideningConfirm
        v-else-if="request.widenings.length"
        :widenings="request.widenings"
        action="Aprovar"
        cancel-label="Recusar"
        :busy="busy === request.id"
        @confirm="(keys) => approve(request, keys)"
        @cancel="reject(request)"
      />
      <div v-else class="flex flex-col gap-2">
        <p class="text-xs text-zinc-400">Com as regras de agora, isto não amplia mais nada.</p>
        <div class="flex gap-2">
          <button type="button" class="btn btn-primary" :disabled="busy === request.id" @click="approve(request, [])">Aprovar</button>
          <button type="button" class="btn btn-ghost" :disabled="busy === request.id" @click="reject(request)">Recusar</button>
        </div>
      </div>
      <p v-if="request.status === 'pending'" class="text-[11px] text-zinc-500">Vence em {{ when(request.expiresAt) }}.</p>
      <p v-if="failures[request.id]" class="text-sm text-rose-300" data-test="request-error">{{ failures[request.id] }}</p>
    </article>
    <ListPager v-model="paged.page.value" :pages="paged.pages.value" :total="paged.total.value" :size="paged.size" />
  </section>
</template>
