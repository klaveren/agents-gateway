<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { describeCron, RUN_STATUS } from '@/lib/cron'
import { fullTime } from '@/lib/format'
import type { ISchedule } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useSchedulesStore } from '@/stores/schedules'

/**
 * A VISÃO GERAL dos agendamentos do projeto em uso (só admin): os dos agentes do projeto e os dos globais que rodam
 * nele, pela próxima execução. Criar e editar é na guia Agendamentos de cada agente.
 */
const auth = useAuthStore()
const projects = useProjectsStore()
const agents = useAgentsStore()
const schedules = useSchedulesStore()
const project = computed(() => projects.list.find((item) => item.id === projects.current))

const list = ref<ISchedule[]>([])
const error = ref<string>()
const loading = ref(false)

async function reload() {
  loading.value = true
  error.value = undefined
  try {
    list.value = await schedules.all(projects.current)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (!auth.isAdmin) return
  await Promise.all([projects.loaded ? undefined : projects.load().catch(() => undefined), agents.loaded ? undefined : agents.load().catch(() => undefined)])
  await reload()
})
watch(
  () => projects.current,
  () => auth.isAdmin && reload(),
)

const agentName = (id: string) => agents.byId.get(id)?.name ?? id
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra vê os agendamentos.</p>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-semibold">Agendamentos{{ project ? ` — ${project.name}` : '' }}</h1>
          <p class="text-xs text-zinc-500">O que os agentes fazem sozinhos. Para criar ou mudar, use a guia Agendamentos do agente.</p>
        </div>
        <button type="button" class="shrink-0 text-xs text-zinc-400 hover:text-zinc-200" :disabled="loading" @click="reload">Atualizar</button>
      </header>
      <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>

      <ul v-if="list.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
        <li v-for="schedule in list" :key="`${schedule.agentId}/${schedule.name}`">
          <RouterLink :to="`/agents/${schedule.agentId}#agendamentos`" class="flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800/40">
            <span class="h-2 w-2 shrink-0 rounded-full" :class="schedule.enabled ? 'bg-emerald-400' : schedule.pausedReason ? 'bg-rose-400' : 'bg-zinc-600'" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-zinc-200">
                <span class="font-mono text-[13px]">{{ schedule.name }}</span>
                <span class="text-zinc-500"> · {{ agentName(schedule.agentId) }}</span>
              </span>
              <span class="block truncate text-xs text-zinc-500">
                {{ describeCron(schedule.cron) ?? schedule.cron }} · <span class="font-mono">{{ schedule.prompt.split('\n')[0] }}</span>
              </span>
            </span>
            <span class="shrink-0 text-right text-xs">
              <span v-if="schedule.nextRunAt" class="block text-zinc-300">{{ fullTime(schedule.nextRunAt) }}</span>
              <span v-else class="block" :class="schedule.pausedReason ? 'text-rose-300' : 'text-zinc-500'">{{ schedule.pausedReason ? 'Pausado' : 'Desligado' }}</span>
              <span v-if="schedule.lastRun" class="block" :class="RUN_STATUS[schedule.lastRun.status].tone">última: {{ RUN_STATUS[schedule.lastRun.status].label }}</span>
            </span>
          </RouterLink>
        </li>
      </ul>
      <p v-else-if="!loading && !error" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">
        Nenhum agendamento{{ project ? ' neste projeto' : '' }}. Crie um na guia Agendamentos de um agente.
      </p>
    </section>
  </div>
</template>
