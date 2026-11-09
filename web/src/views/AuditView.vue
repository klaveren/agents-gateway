<script setup lang="ts">
  import { onMounted, ref, watch } from 'vue'
  import { api } from '@/lib/api'
  import { fullTime } from '@/lib/format'

  /**
   * A auditoria (só quem administra o gateway): cada ação que mudou algo — quem, o quê, em quê, quando, de onde e como
   * terminou (`GET /audit`). ⚖️ Sem o corpo da requisição: senha, chave e texto de conversa não moram aqui.
   */
  interface IAuditEvent {
    id: number
    at: string
    actorId?: string
    actorEmail?: string
    agentId?: string
    conversationId?: string
    action: string
    target?: Record<string, string>
    status: number
    durationMs?: number
    ip?: string
    detail?: string
  }

  /** As ações conhecidas, em português; a que não está aqui aparece como veio (método e rota). */
  const ACTIONS: Record<string, string> = {
    'POST /auth/setup': 'Criou o primeiro admin',
    'POST /auth/login': 'Entrou',
    'POST /auth/logout': 'Saiu',
    'PUT /auth/password': 'Trocou a própria senha',
    'POST /auth/tokens': 'Criou um token de acesso',
    'DELETE /auth/tokens/:id': 'Revogou um token de acesso',
    'POST /users': 'Criou uma conta',
    'PUT /users/:id': 'Alterou uma conta',
    'POST /users/:id/password': 'Redefiniu a senha de uma conta',
    'DELETE /users/:id/sessions': 'Encerrou as sessões de uma conta',
    'PUT /settings': 'Alterou a configuração',
    'POST /agents': 'Criou um agente',
    'PUT /agents/:agentId': 'Salvou um agente',
    'PATCH /agents/:agentId': 'Ajustou um agente',
    'DELETE /agents/:agentId': 'Apagou um agente',
    'PUT /agents/:agentId/shares': 'Compartilhou um agente',
    'POST /mcp-servers': 'Criou um MCP',
    'PUT /mcp-servers/:id': 'Salvou um MCP',
    'DELETE /mcp-servers/:id': 'Apagou um MCP',
    'PUT /mcp-servers/:id/secret': 'Trocou a chave de um MCP',
    'POST /mcp-servers/:id/install': 'Instalou um MCP',
    'POST /providers': 'Criou um provedor',
    'PUT /providers/:id': 'Salvou um provedor',
    'DELETE /providers/:id': 'Apagou um provedor',
    'PUT /providers/:id/key': 'Trocou a chave de um provedor',
    'PUT /providers/:id/models': 'Ativou ou desativou modelos',
    'POST /sessions': 'Abriu uma conversa',
    'POST /sessions/:id/messages': 'Mandou uma mensagem',
    'POST /sessions/:id/turns': 'Mandou uma mensagem',
    'POST /sessions/:id/cancel': 'Parou uma resposta',
    'POST /sessions/:id/compact': 'Compactou uma conversa',
    'PATCH /sessions/:id': 'Trocou o modelo de uma conversa',
    'DELETE /conversations/:id': 'Apagou uma conversa',
    'PUT /conversations/:id/archive': 'Arquivou uma conversa',
    'PUT /conversations/:id/share': 'Compartilhou (ou parou de compartilhar) uma conversa',
    'GET /shared/:id': 'Abriu uma conversa compartilhada',
    'POST /permission-requests/:requestId/approve': 'Aprovou um pedido de permissão',
    'POST /permission-requests/:requestId/reject': 'Recusou um pedido de permissão',
    'POST /agents/:agentId/permission-rules': 'Alterou as permissões de um agente',
    'POST /projects': 'Criou um projeto',
    'PUT /projects/:id/members': 'Alterou os membros de um projeto',
  }
  const label = (event: IAuditEvent) => ACTIONS[event.action] ?? event.action
  const target = (event: IAuditEvent) =>
    Object.values(event.target ?? {})
      .filter(Boolean)
      .join(' · ')

  const PERIODS = [
    { days: 1, label: '24 h' },
    { days: 7, label: '7 dias' },
    { days: 30, label: '30 dias' },
    { days: 90, label: '90 dias' },
  ]
  const days = ref(7)
  const actor = ref('')
  const action = ref('')
  const failed = ref(false)
  const events = ref<IAuditEvent[]>([])
  const next = ref<number>()
  const loading = ref(false)
  const error = ref<string>()

  async function load(more = false) {
    loading.value = true
    error.value = undefined
    try {
      const since = new Date(Date.now() - days.value * 86_400_000).toISOString()
      const query: Record<string, string> = { since, limit: '50' }
      if (actor.value.trim()) query.actor = actor.value.trim()
      if (action.value.trim()) query.action = action.value.trim()
      if (failed.value) query.failed = '1'
      if (more && next.value) query.before = String(next.value)
      const page = await api<{ events: IAuditEvent[]; next?: number }>('/audit', { query })
      events.value = more ? [...events.value, ...page.events] : page.events
      next.value = page.next
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      loading.value = false
    }
  }

  onMounted(() => void load())
  watch([days, failed], () => void load())
</script>

<template>
  <div class="h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-5xl flex-col gap-4">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 class="text-xl font-semibold">Auditoria</h1>
        <div class="ml-auto flex shrink-0 gap-1 rounded-full bg-zinc-900 p-1 text-sm whitespace-nowrap" role="group" aria-label="Período">
          <button
            v-for="period in PERIODS"
            :key="period.days"
            class="rounded-full px-3 py-1"
            :class="days === period.days ? 'bg-zinc-700 text-white' : 'text-zinc-400'"
            :aria-pressed="days === period.days"
            @click="days = period.days"
          >
            {{ period.label }}
          </button>
        </div>
      </header>
      <p class="text-xs text-zinc-500">Cada ação que mudou algo: quem, o quê, quando, de onde e como terminou. Senhas, chaves e o texto das conversas não entram aqui.</p>

      <form class="flex flex-wrap items-center gap-2 text-sm" @submit.prevent="load()">
        <input v-model="actor" class="h-9 rounded-full bg-zinc-900 px-3 text-zinc-200 ring-1 ring-zinc-800" placeholder="Pessoa (e-mail)" aria-label="Pessoa" />
        <input v-model="action" class="h-9 rounded-full bg-zinc-900 px-3 text-zinc-200 ring-1 ring-zinc-800" placeholder="Ação (agents, login…)" aria-label="Ação" />
        <label class="flex items-center gap-2 text-zinc-300"><input v-model="failed" type="checkbox" class="accent-emerald-500" /> Só recusadas ou com falha</label>
        <button type="submit" class="btn btn-secondary">Filtrar</button>
      </form>

      <p v-if="error" class="text-sm text-rose-300" role="alert">{{ error }}</p>
      <p v-if="loading && !events.length" class="text-sm text-zinc-500">Carregando…</p>
      <p v-else-if="!events.length" class="text-sm text-zinc-500">Nenhum evento no período.</p>

      <ul v-else class="flex flex-col gap-2">
        <li v-for="event in events" :key="event.id" class="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span class="rounded-full border px-2 py-0.5 font-mono" :class="event.status >= 400 ? 'border-rose-500/40 text-rose-300' : 'border-emerald-500/40 text-emerald-300'">{{ event.status }}</span>
            <span class="text-zinc-400">{{ fullTime(event.at) }}</span>
            <span class="font-medium text-zinc-200">{{ label(event) }}</span>
            <span v-if="target(event)" class="min-w-0 truncate font-mono text-zinc-400">{{ target(event) }}</span>
          </div>
          <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-zinc-500">
            <span>{{ event.actorEmail ?? event.detail ?? event.actorId ?? 'sem conta' }}</span>
            <span v-if="event.agentId">pelo agente {{ event.agentId }}</span>
            <RouterLink v-if="event.conversationId" :to="`/c/${event.conversationId}`" class="text-emerald-300 hover:underline">conversa</RouterLink>
            <span v-if="event.ip">{{ event.ip }}</span>
            <span v-if="event.action !== label(event)" class="font-mono">{{ event.action }}</span>
          </div>
        </li>
      </ul>
      <button v-if="next" type="button" class="btn btn-secondary self-center" :disabled="loading" @click="load(true)">{{ loading ? 'Carregando…' : 'Carregar mais' }}</button>
    </div>
  </div>
</template>
