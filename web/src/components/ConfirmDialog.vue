<script setup lang="ts">
/**
 * Confirmação dentro da tela, no lugar do `confirm()` do navegador.
 *
 * ⚠️ O `confirm()` nativo é bloqueado em navegador embutido (webview, iframe com sandbox): ele
 * devolve `false` na hora, sem mostrar nada, e o botão parece não funcionar.
 */
defineProps<{ open: boolean; title: string; message?: string; action?: string; busy?: boolean }>()
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
          <button type="button" :disabled="busy" class="rounded-full bg-rose-500 px-4 py-2 text-sm font-medium text-white hover:bg-rose-400 disabled:opacity-50" autofocus @click="emit('confirm')">{{ busy ? 'Apagando…' : (action ?? 'Apagar') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
