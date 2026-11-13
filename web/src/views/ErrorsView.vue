<script setup lang="ts">
  import { computed, onMounted, ref, watch } from 'vue'
  import { api } from '@/lib/api'
  import ListPager from '@/components/ListPager.vue'
  import { usePaged } from '@/composables/usePaged'
  import PeriodPicker from '@/components/PeriodPicker.vue'
  import { copyText } from '@/lib/clipboard'
  import { fullTime } from '@/lib/format'
  import { useAgentsStore } from '@/stores/agents'

  /**
   * O registro de erros (só admin): o que falhou nas conversas — ferramenta com erro, turno que terminou em erro, turno
   * interrompido. ⚖️ É leitura dos turnos (`GET /errors`), sem tabela própria; o recorte (período, agente, ferramenta,
   * tipo) vai na consulta. O "Recusado" é o turno que nem começou (409/422/429 ou 403 agente indisponível ao iniciar), guardado à parte por 30 dias, o servidor conta e limita.
   */
  type TKind = 'tool' | 'turn' | 'aborted' | 'refused'
  interface IErrorItem {
    at: string
    kind: TKind
    /** Ausente na recusa de `POST /sessions` (a conversa nem nasceu). */
    conversationId?: string
    turn?: number
    agentId: string
    title?: string
    tool?: string
    message: string
    /** Só `refused`: o status HTTP e o código da resposta, e de onde veio o pedido. */
    status?: number
    code?: string
    origin?: 'ui' | 'api' | 'hook' | 'schedule'
  }
  interface IErrorLog {
    items: IErrorItem[]
    byKind: Record<TKind, number>
    byTool: Array<{ tool: string; count: number }>
  }

  const KINDS: Array<{ kind: TKind; label: string; badge: string }> = [
    { kind: 'tool', label: 'Ferramenta', badge: 'border-rose-500/40 bg-rose-500/10 text-rose-300' },
    { kind: 'turn', label: 'Turno com erro', badge: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
    { kind: 'aborted', label: 'Interrompido', badge: 'border-zinc-600 bg-zinc-800 text-zinc-300' },
    { kind: 'refused', label: 'Recusado', badge: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
  ]
  const kindOf = (kind: TKind) => KINDS.find((item) => item.kind === kind)!

  const agents = useAgentsStore()
  const days = ref(7)
  const agentId = ref('')
  const tool = ref('')
  const kind = ref<TKind | ''>('')
  const log = ref<IErrorLog>()
  const loading = ref(false)
  const error = ref('')
  /** As ferramentas do seletor: lembradas entre consultas, porque filtrar por uma encolhe o `byTool` a ela mesma. */
  const knownTools = ref<string[]>([])
  const expanded = ref(new Set<string>())
  const copied = ref('')
  let seq = 0

  const toolOptions = computed(() => [...new Set([...knownTools.value, ...(tool.value ? [tool.value] : [])])].sort())
  const rowKey = (item: IErrorItem, index: number) => `${item.conversationId ?? ''}:${item.turn}:${item.kind}:${item.tool ?? ''}:${index}`
  /** A chave da linha é a posição dela na lista INTEIRA: virar a página não troca a linha aberta pela vizinha. */
  const rows = computed(() => (log.value?.items ?? []).map((item, index) => ({ item, key: rowKey(item, index) })))
  const errorPage = usePaged(rows)
  const agentName = (id: string) => (id ? (agents.byId.get(id)?.name ?? id) : 'sem agente')
  const ORIGINS = { ui: 'tela', api: 'API', hook: 'hook', schedule: 'agendamento' }

  async function load() {
    const mine = ++seq
    loading.value = true
    error.value = ''
    try {
      const result = await api<IErrorLog>('/errors', {
        query: { days: days.value, ...(agentId.value ? { agentId: agentId.value } : {}), ...(tool.value ? { tool: tool.value } : {}), ...(kind.value ? { kind: kind.value } : {}) },
      })
      // ⛔ Resposta velha (filtro trocado no meio) não sobrescreve a nova.
      if (mine !== seq) return
      log.value = result
      expanded.value = new Set()
      if (!tool.value) knownTools.value = result.byTool.map((entry) => entry.tool)
    } catch (e) {
      if (mine === seq) error.value = e instanceof Error ? e.message : 'Não foi possível carregar os erros.'
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  watch([days, agentId, tool, kind], () => void load())
  onMounted(() => {
    void agents.ensure().catch(() => undefined)
    void load()
  })

  function toggle(key: string) {
    const next = new Set(expanded.value)
    if (!next.delete(key)) next.add(key)
    expanded.value = next
  }

  async function copy(key: string, text: string) {
    try {
      await copyText(text)
      copied.value = key
      setTimeout(() => {
        if (copied.value === key) copied.value = ''
      }, 1500)
    } catch {
      copied.value = ''
    }
  }

  /** "há 5 min", "há 3 h", "há 2 d": o tempo desde o erro; o horário inteiro fica no `title`. */
  function ago(iso: string, now = Date.now()): string {
    const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
    if (minutes < 1) return 'agora'
    if (minutes < 60) return `há ${minutes} min`
    if (minutes < 1440) return `há ${Math.round(minutes / 60)} h`
    return `há ${Math.round(minutes / 1440)} d`
  }
  function toggleKind(value: TKind) {
    kind.value = kind.value === value ? '' : value
  }
  function toggleTool(value: string) {
    tool.value = tool.value === value ? '' : value
  }
</script>

<template>
  <div class="h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-5xl flex-col gap-4">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 class="text-xl font-semibold">Erros</h1>
        <PeriodPicker v-model="days" />
      </header>

      <div class="flex flex-wrap gap-2 text-sm">
        <select v-model="agentId" class="h-9 rounded-full bg-zinc-900 px-3 text-zinc-200 ring-1 ring-zinc-800" aria-label="Agente">
          <option value="">Todos os agentes</option>
          <option v-for="agent in agents.list" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
        </select>
        <select v-model="tool" class="h-9 rounded-full bg-zinc-900 px-3 text-zinc-200 ring-1 ring-zinc-800" aria-label="Ferramenta">
          <option value="">Todas as ferramentas</option>
          <option v-for="name in toolOptions" :key="name" :value="name">{{ name }}</option>
        </select>
        <select v-model="kind" class="h-9 rounded-full bg-zinc-900 px-3 text-zinc-200 ring-1 ring-zinc-800" aria-label="Tipo">
          <option value="">Todos os tipos</option>
          <option v-for="item in KINDS" :key="item.kind" :value="item.kind">{{ item.label }}</option>
        </select>
      </div>

      <p v-if="error" class="text-sm text-rose-300" role="alert">{{ error }}</p>
      <p v-if="loading && !log" class="text-sm text-zinc-500">Carregando…</p>

      <template v-if="log">
        <div class="flex flex-wrap gap-2" data-test="by-kind">
          <button
            v-for="item in KINDS"
            :key="item.kind"
            class="flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
            :class="[item.badge, kind === item.kind ? 'ring-1 ring-current' : '']"
            :aria-pressed="kind === item.kind"
            @click="toggleKind(item.kind)"
          >
            {{ item.label }}
            <span class="font-semibold tabular-nums">{{ log.byKind[item.kind] }}</span>
          </button>
        </div>

        <section v-if="log.byTool.length" class="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-3" data-test="by-tool">
          <h2 class="mb-2 text-xs font-medium text-zinc-500">Mais falham</h2>
          <ul class="flex flex-wrap gap-1.5">
            <li v-for="entry in log.byTool" :key="entry.tool">
              <button
                class="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs"
                :class="tool === entry.tool ? 'border-rose-500/60 bg-rose-500/15 text-rose-200' : 'border-zinc-700 bg-zinc-800/70 text-zinc-300 hover:bg-zinc-800'"
                :aria-pressed="tool === entry.tool"
                :title="`Filtrar por ${entry.tool}`"
                @click="toggleTool(entry.tool)"
              >
                <span class="font-mono">{{ entry.tool }}</span>
                <span class="tabular-nums text-zinc-500">{{ entry.count }}</span>
              </button>
            </li>
          </ul>
        </section>

        <p v-if="!log.items.length" class="text-sm text-zinc-500">Nenhum erro no período.</p>
        <ul v-else class="flex flex-col gap-2" data-test="error-list">
          <li v-for="{ item, key } in errorPage.items.value" :key="key" class="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2" data-test="error-item">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span class="rounded-full border px-2 py-0.5" :class="kindOf(item.kind).badge">{{ kindOf(item.kind).label }}</span>
              <span class="text-zinc-400" :title="fullTime(item.at)">{{ ago(item.at) }}</span>
              <span class="text-zinc-300">{{ agentName(item.agentId) }}</span>
              <span v-if="item.kind === 'refused'" class="font-mono text-sky-300" data-test="status">{{ item.status }}{{ item.code ? ` ${item.code}` : '' }}</span>
              <span v-if="item.origin" class="text-zinc-500">{{ ORIGINS[item.origin] }}</span>
              <RouterLink v-if="item.conversationId" :to="`/c/${item.conversationId}`" class="min-w-0 truncate text-emerald-300 underline-offset-2 hover:underline" data-test="conversation-link">
                {{ item.title || item.conversationId }}
              </RouterLink>
              <span v-if="item.turn !== undefined" class="text-zinc-500">turno {{ item.turn }}</span>
              <span v-if="item.tool" class="font-mono text-zinc-300">{{ item.tool }}</span>
            </div>
            <div class="mt-1.5 flex items-start gap-2">
              <button
                class="min-w-0 flex-1 cursor-pointer text-left font-mono text-xs break-words whitespace-pre-wrap text-zinc-300"
                :class="expanded.has(key) ? '' : 'line-clamp-2'"
                :aria-expanded="expanded.has(key)"
                data-test="message"
                @click="toggle(key)"
              >
                {{ item.message }}
              </button>
              <button class="btn btn-secondary shrink-0 !px-2 !py-0.5 text-xs" aria-label="Copiar a mensagem" @click="copy(key, item.message)">
                {{ copied === key ? 'Copiado' : 'Copiar' }}
              </button>
            </div>
          </li>
        </ul>
        <ListPager v-model="errorPage.page.value" :pages="errorPage.pages.value" :total="errorPage.total.value" :size="errorPage.size" />
      </template>
    </div>
  </div>
</template>
