<script setup lang="ts">
  import { onMounted, ref } from 'vue'
  import { api } from '@/lib/api'
  import { fullTime } from '@/lib/format'
  import { renderMarkdown } from '@/lib/markdown'

  /**
   * ⚖️ A CONVERSA COMPARTILHADA POR LINK (`/s/<id>`): só leitura, sem conta e sem o menu do gateway. Mostra o que a API
   * pública devolve (`GET /shared/:id`): o título e, de cada turno, a pergunta e a resposta — sem ferramentas, raciocínio,
   * anexos nem custo. Link desligado ou inexistente: "não encontrada".
   */
  const props = defineProps<{ shareId: string }>()

  interface IShared {
    title?: string
    createdAt: string
    turns: Array<{ at: string; request: string; text: string }>
  }

  const conversation = ref<IShared>()
  const missing = ref(false)
  onMounted(async () => {
    conversation.value = await api<IShared>(`/shared/${encodeURIComponent(props.shareId)}`).catch(() => {
      missing.value = true
      return undefined
    })
  })
</script>

<template>
  <div class="h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-3xl flex-col gap-4">
      <p v-if="missing" class="mt-20 text-center text-zinc-400">Esta conversa não está mais compartilhada, ou o link está errado.</p>
      <p v-else-if="!conversation" class="mt-20 text-center text-sm text-zinc-500">Carregando…</p>
      <template v-else>
        <header class="border-b border-zinc-800 pb-3">
          <h1 class="text-lg font-semibold text-zinc-100">{{ conversation.title || 'Conversa' }}</h1>
          <p class="text-xs text-zinc-500">Compartilhada · só leitura · começou em {{ fullTime(conversation.createdAt) }}</p>
        </header>
        <template v-for="(turn, index) in conversation.turns" :key="index">
          <div v-if="turn.request" class="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-emerald-600/90 px-3.5 py-2 text-sm whitespace-pre-wrap wrap-anywhere text-white">
            {{ turn.request }}
          </div>
          <div v-if="turn.text" class="mr-auto max-w-[95%] rounded-2xl rounded-bl-md bg-zinc-800/90 px-3.5 py-2 text-sm leading-relaxed shadow">
            <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
            <div class="prose-agent wrap-anywhere" v-html="renderMarkdown(turn.text)" />
            <div class="mt-1 text-right text-[11px] text-zinc-500">{{ fullTime(turn.at) }}</div>
          </div>
        </template>
        <p v-if="!conversation.turns.length" class="text-sm text-zinc-500">Nenhuma mensagem ainda.</p>
      </template>
    </div>
  </div>
</template>
