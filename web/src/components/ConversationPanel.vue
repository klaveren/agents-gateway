<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { api, authHeaders, url } from '@/lib/api'
  import { fullTime } from '@/lib/format'
  import {
    awaitsPerson,
    linkHost,
    linkKind,
    openCount,
    PLAN_STATUS_LABEL,
    planStatusOf,
    type IConversationPanel,
    type IPanelItem,
    type IPlan,
    type TPanelOp,
    type TPanelStatus,
    type TPlanStatus,
  } from '@/lib/conversationPanel'
  import { renderMarkdown } from '@/lib/markdown'
  import { useAgentsStore } from '@/stores/agents'
  import Icon from './Icon.vue'

  /**
   * O BOARD DA CONVERSA: o documento vivo que o agente mantém (`board`), e os PLANOS dele (`plan`). A pessoa lê e corrige —
   * muda o estado de um item, reordena, responde às perguntas, ajusta o objetivo — e aprova os planos ou pede ajustes. ⚖️ Cada correção é UMA operação no servidor
   * (`PATCH`), que devolve o painel novo: a tela nunca monta o documento sozinha, então não diverge do que o agente lê.
   */
  const props = defineProps<{ conversationId: string; refreshKey?: number; page?: boolean; closable?: boolean }>()
  const emit = defineEmits<{ close: []; count: [number]; waiting: [number] }>()
  const agents = useAgentsStore()

  const panel = ref<IConversationPanel>()
  const error = ref<string>()
  const loading = ref(false)
  const busy = ref(false)
  const menuFor = ref<string>()
  const editingGoal = ref(false)
  const goalDraft = ref('')
  const answers = ref<Record<string, string>>({})
  const showDropped = ref(false)
  const showTimeline = ref(false)
  const showAnswered = ref(false)
  /** A aba: o board (a execução) ou os planos (a estratégia). Abre nos planos quando há um esperando a pessoa. */
  const tab = ref<'board' | 'plans'>('board')
  const openPlan = ref<string>()
  const changesFor = ref<string>()
  const changesText = ref('')

  const base = computed(() => `/conversations/${encodeURIComponent(props.conversationId)}/panel`)

  const SECTIONS: Array<{ status: TPanelStatus; title: string; tone: string }> = [
    { status: 'doing', title: 'Em andamento', tone: 'text-emerald-300' },
    { status: 'blocked', title: 'Bloqueado', tone: 'text-amber-300' },
    { status: 'queued', title: 'Na fila', tone: 'text-zinc-300' },
    { status: 'done', title: 'Entregue', tone: 'text-sky-300' },
  ]
  const ACTIONS: Array<{ status: TPanelStatus; label: string }> = [
    { status: 'queued', label: 'Na fila' },
    { status: 'doing', label: 'Em andamento' },
    { status: 'blocked', label: 'Bloqueado' },
    { status: 'done', label: 'Entregue' },
    { status: 'dropped', label: 'Descartar' },
  ]

  const items = computed(() => panel.value?.items ?? [])
  const inSection = (status: TPanelStatus) => items.value.filter((item) => item.status === status)
  const dropped = computed(() => inSection('dropped'))
  // As em aberto no topo; as respondidas, recolhidas embaixo (corrigir a resposta continua possível).
  const openQuestions = computed(() => (panel.value?.questions ?? []).filter((question) => !question.answer))
  const answeredQuestions = computed(() => (panel.value?.questions ?? []).filter((question) => question.answer))
  const isEmpty = computed(() => !!panel.value && !panel.value.goal && !items.value.length && !panel.value.decisions.length && !panel.value.questions.length)
  const plans = computed(() => panel.value?.plans ?? [])
  const waiting = computed(() => plans.value.filter((plan) => plan.status === 'review').length)
  const statusOfPlan = (plan: IPlan) => planStatusOf(plan, items.value)
  const PLAN_TONE: Record<TPlanStatus, string> = {
    draft: 'bg-zinc-700/40 text-zinc-300',
    review: 'bg-amber-500/15 text-amber-200',
    changes: 'bg-rose-500/15 text-rose-200',
    approved: 'bg-sky-500/15 text-sky-200',
    doing: 'bg-emerald-500/15 text-emerald-200',
    done: 'bg-sky-500/10 text-sky-300',
    dropped: 'bg-zinc-800 text-zinc-500',
  }
  const stepItem = (id?: string) => items.value.find((item) => item.id === id)
  const ITEM_LABEL: Record<TPanelStatus, string> = { queued: 'na fila', doing: 'em andamento', blocked: 'bloqueado', done: 'entregue', dropped: 'descartado' }
  function showPlan(id: string) {
    tab.value = 'plans'
    openPlan.value = id
  }
  async function approve(plan: IPlan) {
    if (await send({ op: 'plan_approve', id: plan.id })) changesFor.value = undefined
  }
  async function askChanges(plan: IPlan) {
    const text = changesText.value.trim()
    if (!text) return
    if (await send({ op: 'plan_changes', id: plan.id, text })) {
      changesFor.value = undefined
      changesText.value = ''
    }
  }
  /** O que o menu de um item oferece: os outros estados; um item entregue ou descartado só reabre. */
  const actionsFor = (item: IPanelItem) =>
    item.status === 'done' || item.status === 'dropped' ? [{ status: 'queued' as const, label: 'Reabrir' }] : ACTIONS.filter((action) => action.status !== item.status)

  function set(next: IConversationPanel) {
    const first = !panel.value
    panel.value = { ...next, items: next.items ?? [], decisions: next.decisions ?? [], questions: next.questions ?? [], plans: next.plans ?? [], history: next.history ?? [] }
    emit('count', openCount(panel.value))
    emit('waiting', panel.value.plans.filter((plan) => plan.status === 'review').length)
    // Ao abrir: com plano esperando a pessoa, vai direto a ele.
    const pending = panel.value.plans.find((plan) => plan.status === 'review')
    if (first && pending) showPlan(pending.id)
  }

  async function load() {
    loading.value = true
    try {
      set(await api<IConversationPanel>(base.value))
      error.value = undefined
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      loading.value = false
    }
  }

  async function send(op: TPanelOp): Promise<boolean> {
    busy.value = true
    try {
      set(await api<IConversationPanel>(base.value, { method: 'PATCH', body: op }))
      error.value = undefined
      return true
    } catch (failure) {
      error.value = `Não foi possível atualizar o board: ${failure instanceof Error ? failure.message : String(failure)}`
      return false
    } finally {
      busy.value = false
    }
  }

  async function setStatus(item: IPanelItem, status: TPanelStatus) {
    menuFor.value = undefined
    await send({ op: 'update', id: item.id, status })
  }

  /** Sobe ou desce DENTRO da seção (os itens ficam numa lista só no servidor, por isso o `before` é o vizinho). */
  async function move(item: IPanelItem, direction: -1 | 1) {
    menuFor.value = undefined
    const siblings = inSection(item.status)
    const at = siblings.findIndex((candidate) => candidate.id === item.id)
    const target = at + direction
    if (target < 0 || target >= siblings.length) return
    // Subir: antes do vizinho de cima. Descer: antes de quem vem DEPOIS do vizinho de baixo (nenhum = vai para o fim).
    const before = direction === -1 ? siblings[target].id : siblings[target + 1]?.id
    await send({ op: 'move', id: item.id, ...(before ? { before } : {}) })
  }

  async function answer(id: string) {
    const text = (answers.value[id] ?? '').trim()
    if (!text) return
    if (await send({ op: 'answer', id, answer: text })) delete answers.value[id]
  }

  function editGoal() {
    goalDraft.value = panel.value?.goal ?? ''
    editingGoal.value = true
  }
  async function saveGoal() {
    const goal = goalDraft.value.trim()
    if (!goal) return void (editingGoal.value = false)
    if (goal !== panel.value?.goal) await send({ op: 'set_goal', goal })
    editingGoal.value = false
  }

  /** ⚠️ O Markdown vem cru (`?format=md`, fora do envelope): por isso o `fetch` direto, não o `api`. */
  async function exportMarkdown() {
    try {
      const response = await fetch(url(base.value, { format: 'md' }), { headers: authHeaders() })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = new Blob([await response.text()], { type: 'text/markdown' })
      const href = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = href
      link.download = `board-${props.conversationId}.md`
      link.click()
      URL.revokeObjectURL(href)
    } catch (failure) {
      error.value = `Não foi possível exportar: ${failure instanceof Error ? failure.message : String(failure)}`
    }
  }

  const agentName = (id: string) => agents.byId.get(id)?.name ?? id
  const turns = (item: IPanelItem) =>
    [
      item.askedTurn !== undefined ? `pedido no turno ${item.askedTurn}` : '',
      item.doneTurn !== undefined ? `${item.status === 'dropped' ? 'descartado' : 'entregue'} no turno ${item.doneTurn}` : '',
    ]
      .filter(Boolean)
      .join(' · ')

  // Abriu, trocou de conversa ou o pai avisou (turno acabou, o agente mexeu no painel): relê.
  watch(
    () => [props.conversationId, props.refreshKey] as const,
    () => void load(),
    { immediate: true },
  )
</script>

<template>
  <div class="flex min-h-0 flex-col gap-5" data-test="conversation-panel">
    <header class="flex flex-wrap items-center gap-2">
      <h2 class="font-medium">Board</h2>
      <span v-if="panel?.updatedAt" class="text-xs text-zinc-500">atualizado {{ fullTime(panel.updatedAt) }}</span>
      <div class="ml-auto flex items-center gap-1">
        <button class="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800" title="Exportar Markdown" aria-label="Exportar Markdown" data-test="export-md" @click="exportMarkdown">
          <Icon name="download" class="h-4 w-4" />
        </button>
        <RouterLink
          v-if="!page"
          :to="`/c/${conversationId}/painel`"
          class="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800"
          title="Abrir em página"
          aria-label="Abrir em página"
          data-test="open-page"
        >
          <Icon name="external" class="h-4 w-4" />
        </RouterLink>
        <button class="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800" title="Atualizar" :disabled="loading" @click="load">
          <Icon name="refresh" class="h-4 w-4" :class="{ 'animate-spin': loading }" />
        </button>
        <button v-if="closable" class="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800" title="Fechar" @click="emit('close')">
          <Icon name="x" class="h-4 w-4" />
        </button>
      </div>
    </header>

    <p v-if="error" class="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" data-test="panel-error">{{ error }}</p>
    <p v-if="!panel && loading" class="text-sm text-zinc-500">Carregando…</p>
    <nav v-if="panel" class="flex gap-1 rounded-xl bg-zinc-900/60 p-1 text-sm" role="tablist">
      <button
        role="tab"
        :aria-selected="tab === 'board'"
        class="flex-1 rounded-lg px-3 py-1.5"
        :class="tab === 'board' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'"
        data-test="tab-board"
        @click="tab = 'board'"
      >
        Board
      </button>
      <button
        role="tab"
        :aria-selected="tab === 'plans'"
        class="flex-1 rounded-lg px-3 py-1.5"
        :class="tab === 'plans' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'"
        data-test="tab-plans"
        @click="tab = 'plans'"
      >
        Planos<span v-if="plans.length" class="text-zinc-500"> · {{ plans.length }}</span>
        <span v-if="waiting" class="ml-1 rounded-full bg-amber-500/20 px-1.5 text-xs text-amber-200" data-test="plans-waiting">{{ waiting }}</span>
      </button>
    </nav>

    <p v-if="isEmpty && tab === 'board'" class="py-6 text-center text-sm text-zinc-500" data-test="panel-empty">O agente ainda não registrou nada nesta conversa.</p>

    <section v-if="panel && tab === 'plans'" class="flex flex-col gap-3" data-test="plans">
      <p v-if="!plans.length" class="py-6 text-center text-sm text-zinc-500" data-test="plans-empty">
        Nenhum plano ainda. Peça ao agente que monte um plano para aprovar: ele aparece aqui.
      </p>
      <article v-for="plan in plans" :key="plan.id" :data-plan="plan.id" class="rounded-xl border border-zinc-800 bg-zinc-900/50">
        <button class="flex w-full items-start gap-2 p-3 text-left" :data-test="`plan-toggle-${plan.id}`" @click="openPlan = openPlan === plan.id ? undefined : plan.id">
          <span class="mt-0.5 text-xs text-zinc-500">{{ openPlan === plan.id ? '▾' : '▸' }}</span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-zinc-100">{{ plan.title }}</span>
            <span class="text-[11px] text-zinc-500">{{ plan.id }} · versão {{ plan.version }} · {{ plan.steps.length }} passos</span>
          </span>
          <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="PLAN_TONE[statusOfPlan(plan)]" data-test="plan-status">{{ PLAN_STATUS_LABEL[statusOfPlan(plan)] }}</span>
        </button>
        <div v-if="openPlan === plan.id" class="flex flex-col gap-3 border-t border-zinc-800 p-3">
          <p v-if="plan.feedback" class="text-xs" :class="plan.feedback.kind === 'approved' ? 'text-success-300' : 'text-rose-200'">
            {{ plan.feedback.kind === 'approved' ? 'Aprovado' : 'Ajustes pedidos' }} por {{ plan.feedback.by }}<template v-if="plan.feedback.text">: {{ plan.feedback.text }}</template>
            <span v-if="plan.feedback.delivered === false" class="text-zinc-500">· o agente vê no próximo turno</span>
          </p>
          <div class="prose-agent wrap-anywhere text-sm" data-test="plan-body" v-html="renderMarkdown(plan.body)" />
          <div v-if="plan.steps.length">
            <h4 class="mb-1 text-xs font-medium tracking-wide text-zinc-400 uppercase">Passos</h4>
            <ol class="flex flex-col gap-1.5" data-test="plan-steps">
              <li v-for="step in plan.steps" :key="step.id" class="flex items-start gap-2 text-sm">
                <span class="w-6 shrink-0 text-xs text-zinc-500">{{ step.id }}</span>
                <span class="min-w-0 flex-1">
                  <span class="text-zinc-200">{{ step.title }}</span>
                  <span v-if="step.detail" class="block text-xs text-zinc-400">{{ step.detail }}</span>
                </span>
                <button
                  v-if="stepItem(step.item)"
                  class="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:text-zinc-100"
                  :title="`Item ${step.item} no board`"
                  @click="tab = 'board'"
                >
                  {{ step.item }} · {{ ITEM_LABEL[stepItem(step.item)!.status] }}
                </button>
              </li>
            </ol>
          </div>
          <div v-if="awaitsPerson(plan)" class="flex flex-col gap-2 border-t border-zinc-800 pt-3">
            <form v-if="changesFor === plan.id" class="flex flex-col gap-2" @submit.prevent="askChanges(plan)">
              <textarea v-model="changesText" rows="3" class="input" placeholder="O que mudar no plano…" aria-label="Ajustes no plano" data-test="plan-changes-input" />
              <div class="flex gap-2">
                <button class="btn btn-sm btn-primary" type="submit" :disabled="busy || !changesText.trim()" data-test="plan-changes-send">Enviar ajustes</button>
                <button class="btn btn-sm btn-ghost" type="button" @click="changesFor = undefined">Cancelar</button>
              </div>
            </form>
            <div v-else class="flex flex-wrap items-center gap-2">
              <button class="btn btn-sm btn-primary" :disabled="busy || !plan.steps.length" data-test="plan-approve" @click="approve(plan)">Aprovar</button>
              <button class="btn btn-sm btn-secondary" :disabled="busy" data-test="plan-changes" @click="changesFor = plan.id">Pedir ajustes</button>
              <span v-if="plan.status === 'draft'" class="text-xs text-zinc-500">O agente ainda não pediu a aprovação.</span>
            </div>
          </div>
        </div>
      </article>
    </section>

    <template v-if="panel && tab === 'board'">
      <section data-test="goal">
        <h3 class="mb-1 text-xs font-medium tracking-wide text-zinc-400 uppercase">Objetivo</h3>
        <form v-if="editingGoal" class="flex flex-col gap-2" @submit.prevent="saveGoal">
          <textarea v-model="goalDraft" rows="2" class="input" data-test="goal-input" aria-label="Objetivo" />
          <div class="flex gap-2">
            <button class="btn btn-sm btn-primary" type="submit" :disabled="busy" data-test="goal-save">Salvar</button>
            <button class="btn btn-sm btn-ghost" type="button" @click="editingGoal = false">Cancelar</button>
          </div>
        </form>
        <p v-else class="group flex items-start gap-2 text-sm text-zinc-200">
          <span :class="{ 'text-zinc-500': !panel.goal }">{{ panel.goal || 'Sem objetivo definido.' }}</span>
          <button class="btn btn-sm btn-ghost shrink-0" data-test="goal-edit" @click="editGoal">{{ panel.goal ? 'Editar' : 'Definir' }}</button>
        </p>
      </section>

      <section v-for="section in SECTIONS" v-show="inSection(section.status).length" :key="section.status" :data-test="`section-${section.status}`">
        <h3 class="mb-2 text-xs font-medium tracking-wide uppercase" :class="section.tone">{{ section.title }} · {{ inSection(section.status).length }}</h3>
        <ul class="flex flex-col gap-2">
          <li v-for="item in inSection(section.status)" :key="item.id" :data-item="item.id" class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-zinc-100">{{ item.title }}</p>
                <p v-if="item.detail" class="mt-0.5 text-xs whitespace-pre-line text-zinc-400">{{ item.detail }}</p>
                <p v-if="item.note" class="mt-1 text-xs whitespace-pre-line" :class="item.status === 'blocked' ? 'text-amber-300' : 'text-zinc-300'">{{ item.note }}</p>
                <div v-if="item.links?.length || item.delegatedTo || item.plan" class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <button v-if="item.plan" class="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-200" data-test="item-plan" @click="showPlan(item.plan.id)">
                    {{ item.plan.id }} · {{ item.plan.step }}
                  </button>
                  <template v-for="(link, index) in item.links ?? []" :key="index">
                    <a v-if="linkKind(link.href) === 'external'" :href="link.href" target="_blank" rel="noopener noreferrer" class="text-emerald-300 hover:underline">
                      {{ link.label }} ↗
                      <!-- ⛔ O texto é do agente: o host de destino aparece sempre que o texto não for o próprio endereço. -->
                      <span v-if="linkHost(link)" data-link-host class="text-[0.7rem] text-zinc-500">{{ linkHost(link) }}</span>
                    </a>
                    <RouterLink v-else-if="linkKind(link.href) === 'conversation'" :to="`/c/${link.href}`" class="text-emerald-300 hover:underline">{{ link.label }}</RouterLink>
                    <span v-else class="font-mono text-zinc-300">{{ link.href ?? link.label }}</span>
                  </template>
                  <component
                    :is="item.delegatedTo.sessionId ? 'RouterLink' : 'span'"
                    v-if="item.delegatedTo"
                    :to="item.delegatedTo.sessionId ? `/c/${item.delegatedTo.sessionId}` : undefined"
                    class="rounded-full bg-violet-500/15 px-2 py-0.5 text-violet-200"
                    data-test="delegated"
                  >
                    com {{ agentName(item.delegatedTo.agentId) }}
                  </component>
                </div>
                <p v-if="turns(item)" class="mt-1 text-[11px] text-zinc-500">{{ turns(item) }}</p>
              </div>
              <div class="relative shrink-0">
                <button
                  class="grid h-7 w-7 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800"
                  title="Ações do item"
                  :data-test="`menu-${item.id}`"
                  @click="menuFor = menuFor === item.id ? undefined : item.id"
                >
                  <Icon name="more" class="h-4 w-4" />
                </button>
                <div v-if="menuFor === item.id" class="absolute right-0 z-10 mt-1 flex w-40 flex-col rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
                  <button
                    v-for="action in actionsFor(item)"
                    :key="action.status"
                    class="rounded-lg px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
                    :disabled="busy"
                    :data-test="`status-${action.status}`"
                    @click="setStatus(item, action.status)"
                  >
                    {{ action.label }}
                  </button>
                  <div class="my-1 border-t border-zinc-800" />
                  <button class="rounded-lg px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800" :disabled="busy" data-test="move-up" @click="move(item, -1)">
                    ↑ Subir
                  </button>
                  <button class="rounded-lg px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800" :disabled="busy" data-test="move-down" @click="move(item, 1)">
                    ↓ Descer
                  </button>
                </div>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="dropped.length" data-test="section-dropped">
        <button class="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase hover:text-zinc-300" data-test="dropped-toggle" @click="showDropped = !showDropped">
          {{ showDropped ? '▾' : '▸' }} Descartado · {{ dropped.length }}
        </button>
        <ul v-if="showDropped" class="flex flex-col gap-2">
          <li v-for="item in dropped" :key="item.id" :data-item="item.id" class="flex items-start gap-2 rounded-xl border border-zinc-800/60 p-3 opacity-70">
            <div class="min-w-0 flex-1">
              <p class="text-sm text-zinc-300 line-through">{{ item.title }}</p>
              <p v-if="item.note" class="mt-1 text-xs text-zinc-400">{{ item.note }}</p>
              <p v-if="turns(item)" class="mt-1 text-[11px] text-zinc-500">{{ turns(item) }}</p>
            </div>
            <button class="btn btn-sm btn-ghost" :disabled="busy" data-test="status-queued" @click="setStatus(item, 'queued')">Reabrir</button>
          </li>
        </ul>
      </section>

      <section v-if="panel.decisions.length" data-test="decisions">
        <h3 class="mb-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">Decisões · {{ panel.decisions.length }}</h3>
        <ul class="flex flex-col gap-2">
          <li v-for="decision in panel.decisions" :key="decision.id" class="rounded-xl border border-zinc-800 p-3 text-sm">
            <p class="text-zinc-100">{{ decision.text }}</p>
            <p v-if="decision.why" class="mt-0.5 text-xs text-zinc-400">{{ decision.why }}</p>
            <p v-if="decision.by || decision.turn !== undefined" class="mt-1 text-[11px] text-zinc-500">
              {{ [decision.by, decision.turn !== undefined ? `turno ${decision.turn}` : ''].filter(Boolean).join(' · ') }}
            </p>
          </li>
        </ul>
      </section>

      <section v-if="panel.questions.length" data-test="questions">
        <h3 v-if="openQuestions.length" class="mb-2 text-xs font-medium tracking-wide text-amber-300 uppercase">Perguntas para você</h3>
        <ul v-if="openQuestions.length" class="flex flex-col gap-2">
          <li v-for="question in openQuestions" :key="question.id" :data-question="question.id" class="rounded-xl border border-zinc-800 p-3 text-sm">
            <p class="text-zinc-100">{{ question.text }}</p>
            <form class="mt-2 flex gap-2" @submit.prevent="answer(question.id)">
              <input v-model="answers[question.id]" class="input min-w-0 flex-1" placeholder="Sua resposta…" :aria-label="`Responder ${question.id}`" data-test="answer-input" />
              <button class="btn btn-sm btn-secondary self-center" type="submit" :disabled="busy || !(answers[question.id] ?? '').trim()" data-test="answer-send">Responder</button>
            </form>
          </li>
        </ul>
        <button
          v-if="answeredQuestions.length"
          class="mt-2 text-xs font-medium tracking-wide text-zinc-500 uppercase hover:text-zinc-300"
          data-test="answered-toggle"
          @click="showAnswered = !showAnswered"
        >
          {{ showAnswered ? '▾' : '▸' }} Respondidas · {{ answeredQuestions.length }}
        </button>
        <ul v-if="showAnswered" class="mt-2 flex flex-col gap-2" data-test="answered">
          <li v-for="question in answeredQuestions" :key="question.id" :data-question="question.id" class="rounded-xl border border-zinc-800/70 p-3 text-sm">
            <p class="text-zinc-400">{{ question.text }}</p>
            <p class="mt-1 text-xs text-emerald-300">
              Resposta: {{ question.answer }}
              <span v-if="question.delivered === false" class="text-zinc-500">· o agente vê no próximo turno</span>
            </p>
            <form class="mt-2 flex gap-2" @submit.prevent="answer(question.id)">
              <input
                v-model="answers[question.id]"
                class="input min-w-0 flex-1"
                placeholder="Corrigir a resposta…"
                :aria-label="`Responder ${question.id}`"
                data-test="answer-input"
              />
              <button class="btn btn-sm btn-secondary self-center" type="submit" :disabled="busy || !(answers[question.id] ?? '').trim()" data-test="answer-send">Responder</button>
            </form>
          </li>
        </ul>
      </section>

      <section v-if="panel.history.length" data-test="timeline">
        <button class="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase hover:text-zinc-300" data-test="timeline-toggle" @click="showTimeline = !showTimeline">
          {{ showTimeline ? '▾' : '▸' }} Linha do tempo · {{ panel.history.length }}
        </button>
        <ol v-if="showTimeline" class="flex flex-col gap-1.5 border-l border-zinc-800 pl-3">
          <li v-for="(event, index) in [...panel.history].reverse()" :key="index" class="text-xs text-zinc-400">
            <span class="text-zinc-500">
              {{ fullTime(event.at) }}
              <template v-if="event.turn !== undefined">· turno {{ event.turn }}</template>
              · {{ event.by }}
            </span>
            <br />
            {{ event.text }}
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>
