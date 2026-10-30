<script setup lang="ts">
import { computed } from 'vue'
import { CLASSIFICATION_COLOR, CLASSIFICATION_LABEL, shortTime } from '@/lib/format'
import type { IConversation } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import AgentAvatar from './AgentAvatar.vue'

const props = defineProps<{ conversation: IConversation; active: boolean; unread: boolean; running?: boolean; showOwner: boolean }>()

const agents = useAgentsStore()
const agentName = computed(() => agents.byId.get(props.conversation.agentId)?.name ?? props.conversation.agentId)
const owner = computed(() => props.conversation.metadata?.owner?.email ?? props.conversation.metadata?.owner?.id)

/** A última fala: a do agente, se respondeu; senão, a pergunta que ficou sem resposta. */
const preview = computed(() => {
  const last = props.conversation.preview
  if (!last) return 'Sem mensagens ainda'
  return plain(last.text) || `Você: ${plain(last.request)}`
})

/** A prévia é uma linha de texto: a marcação do markdown (cercas, asteriscos) só atrapalha ali. */
function plain(text: string): string {
  return text
    .replace(/```\w*/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
</script>

<template>
  <RouterLink
    :to="`/c/${conversation.id}`"
    class="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors"
    :class="active ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'"
  >
    <AgentAvatar :name="agentName" :provider="conversation.provider" size="sm" />
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline gap-2">
        <span class="truncate text-sm font-medium" :class="unread ? 'text-white' : 'text-zinc-100'">{{ conversation.title || 'Conversa sem título' }}</span>
        <span class="ml-auto shrink-0 text-[11px]" :class="unread ? 'text-emerald-400' : 'text-zinc-500'">{{ shortTime(conversation.preview?.at ?? conversation.updatedAt) }}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="truncate text-xs" :class="unread ? 'text-zinc-200' : 'text-zinc-400'">
          <span class="text-zinc-500">{{ agentName }}<template v-if="showOwner && owner"> · {{ owner }}</template>:</span>
          {{ preview }}
        </span>
        <span
          v-if="conversation.classification"
          class="ml-auto h-2 w-2 shrink-0 rounded-full"
          :class="CLASSIFICATION_COLOR[conversation.classification]"
          :title="CLASSIFICATION_LABEL[conversation.classification]"
        />
        <span v-if="running" class="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400" :class="{ 'ml-0': conversation.classification }" title="Rodando agora" />
        <span v-if="unread" class="ml-auto h-2 w-2 shrink-0 rounded-full bg-emerald-400" :class="{ 'ml-0': conversation.classification || running }" title="Nova atividade" />
      </div>
    </div>
  </RouterLink>
</template>
