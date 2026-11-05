<script setup lang="ts">
  import ConversationPanel from '@/components/ConversationPanel.vue'

  /** `/c/:id/painel`: o Painel da conversa em página inteira (para ler com calma, colar o link ou imprimir). */
  defineProps<{ id: string }>()
</script>

<template>
  <div class="h-full overflow-y-auto bg-zinc-950">
    <div class="mx-auto max-w-3xl px-4 py-5">
      <RouterLink :to="`/c/${id}`" class="mb-4 inline-block text-sm text-zinc-400 hover:text-zinc-100">← Voltar à conversa</RouterLink>
      <ConversationPanel :key="id" :conversation-id="id" page />
    </div>
  </div>
</template>
