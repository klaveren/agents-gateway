<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { renderMarkdown } from '@/lib/markdown'
  import type { IAgentReply } from '@/lib/notice'
  import { useAgentsStore } from '@/stores/agents'

  /**
   * 🤝 A resposta de outro agente que o gateway entregou na conversa (não é fala da pessoa): quem respondeu, o link para a
   * conversa dele e o texto em markdown, recolhido depois de algumas linhas (o relatório longo não toma a tela).
   */
  const props = defineProps<{ reply: IAgentReply; at?: string }>()
  const agents = useAgentsStore()
  const name = computed(() => agents.byId.get(props.reply.agentId)?.name ?? props.reply.agentId)
  const long = computed(() => props.reply.body.length > 600 || props.reply.body.split('\n').length > 10)
  const open = ref(false)
</script>

<template>
  <div
    class="w-full rounded-xl border px-3.5 py-2 text-sm"
    :class="reply.ok ? 'border-zinc-700 bg-zinc-900/70' : 'border-rose-500/40 bg-rose-500/10'"
    data-test="agent-reply"
  >
    <div class="flex flex-wrap items-center gap-x-2 text-xs">
      <span class="font-semibold" :class="reply.ok ? 'text-zinc-200' : 'text-rose-200'">{{ reply.ok ? `Resposta de ${name}` : `A conversa com ${name} falhou` }}</span>
      <RouterLink :to="`/c/${reply.conversationId}`" class="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">ver a conversa →</RouterLink>
      <span v-if="at" class="ml-auto text-zinc-500">{{ at }}</span>
    </div>
    <p v-if="!reply.ok" class="mt-1 font-mono text-xs whitespace-pre-wrap wrap-anywhere text-rose-200">{{ reply.body }}</p>
    <template v-else>
      <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
      <div class="prose-agent mt-1 wrap-anywhere" :class="long && !open ? 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''" v-html="renderMarkdown(reply.body)" />
      <button v-if="long" type="button" class="mt-1 text-xs text-zinc-400 hover:text-zinc-200" data-test="agent-reply-toggle" @click="open = !open">
        {{ open ? 'recolher' : 'ver tudo' }}
      </button>
    </template>
  </div>
</template>
