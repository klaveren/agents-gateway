<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import ConversationList from '@/components/ConversationList.vue'
import NewConversation from '@/components/NewConversation.vue'
import ThreadView from '@/components/ThreadView.vue'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useThreadStore } from '@/stores/thread'

const props = defineProps<{ id?: string }>()

const route = useRoute()
const auth = useAuthStore()
const conversations = useConversationsStore()
const thread = useThreadStore()

const isNew = computed(() => route.name === 'new')
const hasDetail = computed(() => isNew.value || !!props.id)

onMounted(() => void conversations.load(auth.isAdmin))

watch(
  () => props.id,
  (id) => {
    conversations.select(id)
    // A conversa que acabou de nascer aqui já está aberta — reabrir apagaria o turno em andamento.
    if (id && id !== thread.sessionId) void thread.open(id, conversations.find(id))
  },
  { immediate: true },
)

// O cabeçalho acompanha a lista: o evento ao vivo traz título, contagem e rótulo novos.
watch(
  () => (props.id ? conversations.find(props.id) : undefined),
  (conversation) => {
    thread.setHeader(conversation)
    if (conversation && !thread.sending) void thread.refresh()
  },
)

</script>

<template>
  <div class="flex h-full">
    <aside class="h-full w-full shrink-0 border-r border-zinc-800/80 lg:w-[380px]" :class="hasDetail ? 'hidden lg:block' : 'block'">
      <ConversationList />
    </aside>
    <div class="h-full min-w-0 flex-1" :class="hasDetail ? 'block' : 'hidden lg:block'">
      <NewConversation v-if="isNew" />
      <ThreadView v-else-if="id" :key="id" />
      <div v-else class="grid h-full place-items-center text-center text-zinc-500">
        <div>
          <div class="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-2xl bg-zinc-900 text-2xl">💬</div>
          <p class="font-medium text-zinc-300">Escolha uma conversa</p>
          <p class="text-sm">ou comece uma nova com qualquer agente.</p>
        </div>
      </div>
    </div>
  </div>
</template>
