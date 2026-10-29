<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import { commandSuggestions, useAgentCommands } from '@/lib/commands'
import { describeCron, RUN_STATUS, SCHEDULE_PRESETS } from '@/lib/cron'
import { fullTime } from '@/lib/format'
import type { ISchedule, IScheduleRun, TScheduleInput } from '@/lib/types'
import { useProjectsStore } from '@/stores/projects'
import { useSchedulesStore } from '@/stores/schedules'
import ConfirmDialog from './ConfirmDialog.vue'

/**
 * A guia Agendamentos de um agente: em cada horário do cron o agente recebe o texto (um `/command`, uma skill ou um
 * pedido livre), em nome de quem criou. ⚠️ Mora DENTRO do formulário do agente, como os hooks: nada aqui é `<form>`
 * nem submete com Enter, e nenhum input tem validação nativa. Quem valida é o servidor.
 */
const props = defineProps<{ agentId: string; projectId?: string }>()
const schedules = useSchedulesStore()
const projects = useProjectsStore()

const list = computed(() => schedules.byAgent[props.agentId] ?? [])
const loadError = ref<string>()
/** O agendamento aberto: `''` = um novo; `undefined` = nenhum. */
const open = ref<string>()
const draft = ref<TScheduleInput & { name: string }>(blank())
const issues = ref<Record<string, string[]>>({})
const error = ref<string>()
const busy = ref(false)
const runs = ref<IScheduleRun[]>([])
const confirm = ref<string>()
const started = ref(false)

function blank(): TScheduleInput & { name: string } {
  return { name: '', cron: '0 8 * * 1-5', timezone: 'America/Sao_Paulo', prompt: '', session: 'new', projectId: null, enabled: true }
}

onMounted(async () => {
  await reload()
  if (!props.projectId && !projects.loaded) await projects.load().catch(() => undefined)
})
watch(
  () => props.agentId,
  () => reload(),
)

async function reload() {
  loadError.value = undefined
  await schedules.load(props.agentId).catch((failure) => (loadError.value = describe(failure)))
}

function describe(failure: unknown): string {
  if (failure instanceof ApiError && failure.status === 422) {
    const items = Array.isArray(failure.details) ? (failure.details as Array<{ field?: string; message?: string }>) : []
    return items.map((item) => (item.field ? `${item.field}: ${item.message}` : item.message)).join('; ') || failure.message
  }
  return failure instanceof Error ? failure.message : String(failure)
}

const selected = computed(() => list.value.find((schedule) => schedule.name === open.value))
// ⚠️ No script, e não no template: lá `undefined` não é garantido como o valor global no build.
const editing = computed(() => open.value !== undefined)
const addingNew = computed(() => open.value === '')
const cronText = computed(() => describeCron(draft.value.cron))

/** O `/` do texto: as skills e os commands do agente, enquanto a pessoa ainda escolhe (sem espaço). */
const commands = useAgentCommands(
  computed(() => props.agentId),
  computed(() => props.projectId ?? draft.value.projectId ?? undefined),
)
const slashHints = computed(() => commandSuggestions(draft.value.prompt, commands.value.filter((command) => (command.kind ?? 'command') === 'command' || command.kind === 'skill')))
const pick = (id: string) => (draft.value.prompt = `/${id} `)

async function openSchedule(name: string | undefined) {
  issues.value = {}
  error.value = undefined
  runs.value = []
  started.value = false
  if (open.value === name) return (open.value = undefined)
  open.value = name
  const schedule = list.value.find((entry) => entry.name === name)
  draft.value = schedule
    ? { name: schedule.name, cron: schedule.cron, timezone: schedule.timezone, prompt: schedule.prompt, session: schedule.session, projectId: schedule.projectId ?? null, enabled: schedule.enabled }
    : blank()
  if (schedule) await loadRuns()
}

async function loadRuns() {
  if (!selected.value) return
  runs.value = await schedules.runs(props.agentId, selected.value.name).catch(() => [])
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
    const created = await schedules.create(props.agentId, draft.value)
    open.value = created.name
    await loadRuns()
  })

const save = () =>
  run(async () => {
    const { name, ...change } = draft.value
    await schedules.update(props.agentId, name, change)
  })

/** "Rodar agora": o servidor responde na hora; o histórico se atualiza enquanto a execução anda. */
const runNow = () =>
  run(async () => {
    if (!selected.value) return
    await schedules.runNow(props.agentId, selected.value.name)
    started.value = true
    for (const wait of [800, 3000, 8000, 20000]) setTimeout(() => void loadRuns().then(() => schedules.load(props.agentId)), wait)
  })

async function confirmed() {
  const name = confirm.value
  confirm.value = undefined
  if (!name) return
  await run(async () => {
    await schedules.remove(props.agentId, name)
    open.value = undefined
  })
}

const summary = (schedule: ISchedule) => describeCron(schedule.cron) ?? schedule.cron
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-xs text-zinc-500">
      Em cada horário o agente recebe o texto do agendamento — um <code>/command</code>, uma skill ou um pedido livre —, em nome de quem criou. A conversa aparece na caixa de entrada dessa conta. Horário perdido com o gateway fora do ar não roda depois: fica registrado.
    </p>
    <p v-if="loadError" class="text-sm text-rose-300">{{ loadError }}</p>

    <ul class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
      <li v-for="schedule in list" :key="schedule.name">
        <button type="button" class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-800/40" @click="openSchedule(schedule.name)">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="schedule.enabled ? 'bg-emerald-400' : schedule.pausedReason ? 'bg-rose-400' : 'bg-zinc-600'" />
          <span class="min-w-0 flex-1">
            <span class="block truncate font-mono text-[13px] text-zinc-200">{{ schedule.name }}</span>
            <span class="block truncate text-xs text-zinc-500">
              {{ summary(schedule) }}
              <template v-if="schedule.nextRunAt"> · próxima: {{ fullTime(schedule.nextRunAt) }}</template>
              <template v-else> · {{ schedule.pausedReason ? 'pausado pelo sistema' : 'desligado' }}</template>
              <template v-if="schedule.lastRun"> · última: {{ RUN_STATUS[schedule.lastRun.status].label }}</template>
            </span>
          </span>
          <span class="text-xs text-zinc-500">{{ open === schedule.name ? '▴' : '▾' }}</span>
        </button>
      </li>
      <li v-if="!list.length && !loadError" class="px-3 py-3 text-xs text-zinc-500">Nenhum agendamento ainda.</li>
    </ul>
    <button v-if="!addingNew" type="button" class="self-start rounded-full bg-zinc-800 px-4 py-1.5 text-sm hover:bg-zinc-700" @click="openSchedule('')">+ Novo agendamento</button>

    <div v-if="editing" class="flex flex-col gap-3 rounded-xl border border-zinc-800 p-3">
      <h3 class="text-sm font-medium text-zinc-200">{{ selected ? `Agendamento ${selected.name}` : 'Novo agendamento' }}</h3>
      <p v-if="selected?.pausedReason" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{{ selected.pausedReason }} Ligue de novo para voltar a rodar.</p>
      <label v-if="!selected" class="field">
        Nome
        <input v-model="draft.name" class="input font-mono" placeholder="resumo-diario" @keydown.enter.prevent />
        <small class="hint">Letras minúsculas, números e hífen. Não muda depois.</small>
        <small v-for="m in issues.name" :key="m" class="error">{{ m }}</small>
      </label>

      <div class="field">
        Quando
        <div class="flex flex-wrap gap-1.5">
          <button v-for="preset in SCHEDULE_PRESETS" :key="preset.cron" type="button" class="chip" :class="{ on: draft.cron === preset.cron }" @click="draft.cron = preset.cron">{{ preset.label }}</button>
        </div>
        <div class="grid gap-3 sm:grid-cols-[1fr_14rem]">
          <input v-model="draft.cron" class="input font-mono text-sm" placeholder="0 8 * * 1-5" @keydown.enter.prevent />
          <input v-model="draft.timezone" class="input text-sm" placeholder="America/Sao_Paulo" title="Fuso horário" @keydown.enter.prevent />
        </div>
        <small class="hint">
          <template v-if="cronText">Roda <strong class="font-medium text-zinc-300">{{ cronText }}</strong> ({{ draft.timezone || 'America/Sao_Paulo' }}).</template>
          <template v-else>Cron de 5 campos: minuto, hora, dia do mês, mês, dia da semana (0 ou 7 = domingo). No mínimo 5 minutos entre execuções.</template>
          <template v-if="selected?.nextRunAt && draft.cron === selected.cron"> Próxima: {{ fullTime(selected.nextRunAt) }}.</template>
        </small>
        <small v-for="m in [...(issues.cron ?? []), ...(issues.timezone ?? [])]" :key="m" class="error">{{ m }}</small>
      </div>

      <label class="field">
        O que o agente faz
        <textarea v-model="draft.prompt" rows="4" class="input text-sm" placeholder="/resumir as conversas de ontem, ou um pedido livre" />
        <span v-if="slashHints.length" class="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-xs font-normal">
          <button v-for="hint in slashHints" :key="hint.id" type="button" class="flex items-baseline gap-2 px-3 py-1.5 text-left hover:bg-zinc-800" @click="pick(hint.id)">
            <span class="font-mono text-zinc-200">/{{ hint.id }}</span>
            <span class="text-[10px] uppercase text-zinc-500">{{ hint.kind === 'skill' ? 'skill' : 'command' }}</span>
            <span class="min-w-0 flex-1 truncate text-zinc-500">{{ hint.description }}</span>
          </button>
        </span>
        <small class="hint">Como se fosse digitado no chat: comece com <code>/</code> para escolher um command ou uma skill do agente.</small>
        <small v-for="m in issues.prompt" :key="m" class="error">{{ m }}</small>
      </label>

      <div class="field">
        Conversa
        <div class="flex flex-wrap gap-1.5">
          <button type="button" class="chip" :class="{ on: draft.session === 'new' }" @click="draft.session = 'new'">Nova a cada execução</button>
          <button type="button" class="chip" :class="{ on: draft.session === 'continuous' }" @click="draft.session = 'continuous'">Contínua</button>
        </div>
        <small class="hint">{{ draft.session === 'new' ? 'Cada execução vira uma conversa.' : 'Todas as execuções na mesma conversa: o agente lembra das anteriores.' }}</small>
      </div>

      <label v-if="!projectId && projects.list.length" class="field">
        Projeto
        <select v-model="draft.projectId" class="input text-sm">
          <option :value="null">Nenhum (global)</option>
          <option v-for="project in projects.list" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
        <small class="hint">O agente é global: escolha em que projeto a conversa roda (as rules e specs dele valem).</small>
        <small v-for="m in issues.projectId" :key="m" class="error">{{ m }}</small>
      </label>

      <label class="flex items-center gap-2 text-sm text-zinc-300"><input v-model="draft.enabled" type="checkbox" class="accent-emerald-500" /> Ligado</label>

      <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <div class="flex flex-wrap gap-2">
        <button v-if="!selected" type="button" :disabled="busy" class="rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="create">Criar agendamento</button>
        <template v-else>
          <button type="button" :disabled="busy" class="rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="save">Salvar agendamento</button>
          <button type="button" :disabled="busy" class="rounded-full bg-zinc-800 px-4 py-1.5 text-sm hover:bg-zinc-700" @click="runNow">Rodar agora</button>
          <span v-if="started" class="self-center text-xs text-emerald-300">começou — acompanhe abaixo</span>
          <button type="button" :disabled="busy" class="ml-auto rounded-full px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-500/10" @click="confirm = selected.name">Apagar</button>
        </template>
      </div>

      <div v-if="selected" class="border-t border-zinc-800/80 pt-3">
        <div class="mb-2 flex items-center gap-2">
          <h4 class="text-sm font-medium text-zinc-200">Últimas execuções</h4>
          <button type="button" class="ml-auto text-xs text-zinc-400 hover:text-zinc-200" @click="loadRuns">atualizar</button>
        </div>
        <ul v-if="runs.length" class="divide-y divide-zinc-800 rounded-lg border border-zinc-800 text-xs">
          <li v-for="entry in runs" :key="entry.id" class="flex items-center gap-3 px-3 py-1.5">
            <span class="w-36 shrink-0 text-zinc-400">{{ fullTime(entry.scheduledFor) }}</span>
            <span class="w-14 shrink-0" :class="RUN_STATUS[entry.status].tone">{{ RUN_STATUS[entry.status].label }}</span>
            <span class="w-12 shrink-0 text-zinc-500">{{ entry.trigger === 'manual' ? 'manual' : '' }}</span>
            <span class="min-w-0 flex-1 truncate" :class="entry.status === 'error' ? 'text-rose-300/80' : 'text-zinc-500'" :title="entry.error">{{ entry.error }}</span>
            <RouterLink v-if="entry.sessionId" :to="`/c/${entry.sessionId}`" class="shrink-0 text-emerald-300 hover:underline">conversa</RouterLink>
          </li>
        </ul>
        <p v-else class="text-xs text-zinc-500">Nenhuma execução ainda.</p>
      </div>
    </div>

    <ConfirmDialog
      :open="!!confirm"
      :title="`Apagar o agendamento ${confirm ?? ''}?`"
      message="Ele para de rodar e o histórico some. As conversas que ele abriu continuam."
      action="Apagar"
      tone="danger"
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
