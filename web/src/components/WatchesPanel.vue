<script setup lang="ts">
  import { computed, onBeforeUnmount, ref } from 'vue'
  import { ago, span } from '@/lib/format'
  import type { IWatchItem } from '@/lib/types'
  import ConfirmDialog from './ConfirmDialog.vue'
  import Icon from './Icon.vue'

  /**
   * As vigias armadas na conversa (`watch_start`, `wake_me`), logo acima da caixa de mensagem: o que o gateway está
   * esperando por ela. É a prova de que o "eu te aviso" do agente tem algo conferindo de verdade.
   * ⚖️ Cancelar pede confirmação: a vigia cancelada não avisa ninguém, nem o agente.
   */
  const props = defineProps<{ items: IWatchItem[]; stop: (watchId: string) => Promise<boolean> }>()

  /** O relógio da faixa: "há 2 min" e "prazo em 58 min" andam sem reler o servidor. */
  const now = ref(new Date())
  const clock = setInterval(() => (now.value = new Date()), 30_000)
  onBeforeUnmount(() => clearInterval(clock))

  function detail(watch: IWatchItem): string {
    const left = new Date(watch.deadlineAt).getTime() - now.value.getTime()
    const parts = [ago(watch.createdAt, now.value)]
    if (watch.kind === 'timer') parts.push(left > 0 ? `acorda em ${span(left)}` : 'acordando')
    else {
      if (watch.everySeconds) parts.push(`confere a cada ${span(watch.everySeconds * 1000)}`)
      parts.push(left > 0 ? `prazo em ${span(left)}` : 'prazo vencido')
    }
    return parts.join(' · ')
  }

  /** Fechada, como as delegações e as tarefas: a linha de cima mostra a próxima a acordar. */
  const open = ref(false)
  const next = computed(() => [...props.items].sort((a, b) => new Date(a.deadlineAt).getTime() - new Date(b.deadlineAt).getTime())[0])
  const iconOf = (watch: IWatchItem) => (watch.kind === 'timer' ? 'clock' : 'refresh')
  const kindOf = (watch: IWatchItem) => (watch.kind === 'timer' ? 'Despertador' : 'Vigiando')

  const asking = ref<IWatchItem>()
  const busy = ref(false)

  async function confirm() {
    if (!asking.value || busy.value) return
    busy.value = true
    try {
      await props.stop(asking.value.id)
    } finally {
      busy.value = false
      asking.value = undefined
    }
  }
</script>

<template>
  <div class="border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-2 text-sm" data-test="watches">
    <button v-if="next" type="button" class="flex w-full min-w-0 items-center gap-2 text-left" :aria-expanded="open" data-test="watches-toggle" @click="open = !open">
      <Icon :name="iconOf(next)" class="h-4 w-4 shrink-0 text-zinc-400" :title="kindOf(next)" />
      <span v-if="items.length > 1" class="shrink-0 text-xs text-zinc-500">{{ items.length }}</span>
      <template v-if="!open">
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-emerald-200">{{ next.label }}</span>
        <span class="shrink-0 text-xs text-zinc-500">{{ detail(next).split(' · ').slice(1).join(' · ') }}</span>
      </template>
      <span v-else class="min-w-0 flex-1 text-xs text-zinc-500">{{ items.length > 1 ? 'esperas desta conversa' : kindOf(next) }}</span>
      <span class="shrink-0 text-xs text-zinc-500">{{ open ? '▾' : '▴' }}</span>
    </button>
    <ul v-if="open" class="mt-1.5 flex max-h-32 flex-col gap-1.5 overflow-y-auto">
      <li v-for="watch in items" :key="watch.id" class="flex items-center gap-2">
        <Icon :name="iconOf(watch)" class="h-3.5 w-3.5 shrink-0 text-zinc-500" :aria-label="kindOf(watch)" />
        <span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span class="min-w-0 truncate text-[13px] font-medium text-emerald-200" :title="watch.command">{{ watch.label }}</span>
          <span class="text-xs text-zinc-500">{{ detail(watch) }}</span>
        </span>
        <button type="button" class="shrink-0 rounded-md px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" @click="asking = watch">Cancelar</button>
      </li>
    </ul>
    <ConfirmDialog
      :open="!!asking"
      :title="asking?.kind === 'timer' ? 'Desligar o despertador?' : 'Parar de vigiar?'"
      :message="`“${asking?.label ?? ''}”: o gateway para de esperar, e o agente não é avisado.`"
      :action="asking?.kind === 'timer' ? 'Desligar' : 'Parar de vigiar'"
      :busy="busy"
      busy-label="Parando…"
      @confirm="confirm"
      @cancel="asking = undefined"
    />
  </div>
</template>
