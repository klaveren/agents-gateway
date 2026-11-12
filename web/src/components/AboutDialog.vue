<script setup lang="ts">
  import { ref, watch } from 'vue'
  import { api } from '@/lib/api'

  /** "Sobre": a versão e o build que estão rodando. ⚖️ Lê só ao abrir: o menu da conta não custa uma chamada. */
  const props = defineProps<{ open: boolean }>()
  const emit = defineEmits<{ close: [] }>()

  interface IAbout {
    name: string
    version: string
    /** O commit de onde o instalador saiu; ausente quando o servidor não sabe (dev, imagem). */
    build?: string
  }

  const about = ref<IAbout>()
  const failed = ref(false)

  watch(
    () => props.open,
    async (open) => {
      if (!open) return
      failed.value = false
      try {
        about.value = await api<IAbout>('/about')
      } catch {
        failed.value = true
      }
    },
    { immediate: true },
  )
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" @click.self="emit('close')" @keydown.esc="emit('close')">
      <div role="dialog" aria-modal="true" aria-labelledby="about-title" class="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl" data-test="about-dialog">
        <h2 id="about-title" class="font-semibold">{{ about?.name ?? 'Agents Gateway' }}</h2>
        <p v-if="failed" class="mt-1.5 text-sm text-rose-300" data-test="about-error">Não foi possível ler a versão.</p>
        <dl v-else-if="about" class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt class="text-zinc-500">Versão</dt>
          <dd class="font-mono text-zinc-100" data-test="about-version">{{ about.version }}</dd>
          <template v-if="about.build">
            <dt class="text-zinc-500">Build</dt>
            <dd class="font-mono text-zinc-100" data-test="about-build">{{ about.build }}</dd>
          </template>
        </dl>
        <p v-else class="mt-1.5 text-sm text-zinc-500">Lendo…</p>
        <div class="mt-5 flex justify-end">
          <button type="button" class="btn btn-ghost" autofocus @click="emit('close')">Fechar</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
