<script setup lang="ts">
import { computed } from 'vue'

/**
 * Confirmação dentro da tela, no lugar do `confirm()` do navegador.
 *
 * ⚠️ O `confirm()` nativo é bloqueado em navegador embutido (webview, iframe com sandbox): ele
 * devolve `false` na hora, sem mostrar nada, e o botão parece não funcionar.
 */
/** `tone: 'neutral'` para confirmar o que não destrói (salvar): o vermelho fica para apagar. */
const props = defineProps<{ open: boolean; title: string; message?: string; action?: string; busy?: boolean; busyLabel?: string; tone?: 'danger' | 'neutral' }>()

/** ⚠️ O rótulo de "ocupado" segue a ação ("Revogar" → "Revogando…"): fixo em "Apagando…" mentia em quem não apaga. */
const BUSY: Record<string, string> = { Apagar: 'Apagando…', Remover: 'Removendo…', Revogar: 'Revogando…', Encerrar: 'Encerrando…', Salvar: 'Salvando…', Criar: 'Criando…' }
const label = computed(() => {
  const action = props.action ?? 'Apagar'
  return props.busy ? (props.busyLabel ?? BUSY[action] ?? `${action}…`) : action
})
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" @click.self="emit('cancel')" @keydown.esc="emit('cancel')">
      <div role="alertdialog" aria-modal="true" class="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
        <h2 class="font-semibold">{{ title }}</h2>
        <p v-if="message" class="mt-1.5 text-sm text-zinc-400">{{ message }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="rounded-full px-4 py-2 text-sm hover:bg-zinc-800" @click="emit('cancel')">Cancelar</button>
          <button type="button" :disabled="busy" :class="tone === 'neutral' ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400' : 'bg-rose-500 text-white hover:bg-rose-400'" class="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50" autofocus @click="emit('confirm')">{{ label }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
