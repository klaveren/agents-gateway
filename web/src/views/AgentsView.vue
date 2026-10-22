<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AgentAvatar from '@/components/AgentAvatar.vue'
import AgentForm from '@/components/AgentForm.vue'
import Icon from '@/components/Icon.vue'
import { PROVIDER_LABEL } from '@/lib/format'
import type { IAgentDetail } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{ id?: string }>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const agents = useAgentsStore()

const detail = ref<IAgentDetail>()
const template = ref<IAgentDetail>()
const error = ref<string>()

const creating = computed(() => route.name === 'agent-new')
const builtIns = computed(() => agents.list.filter((agent) => agent.builtIn))
const created = computed(() => agents.list.filter((agent) => !agent.builtIn))

onMounted(() => void agents.loadTools().catch(() => undefined))

watch(
  () => [props.id, creating.value] as const,
  async ([id]) => {
    error.value = undefined
    detail.value = undefined
    if (!id) return
    try {
      detail.value = await agents.detail(id)
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    }
  },
  { immediate: true },
)

/** A cópia nasce sem id e com "(cópia)" no nome: o id é escolhido de novo, e não colide com o original. */
function duplicate(source: IAgentDetail) {
  template.value = { ...source, id: '', name: `${source.name.replace(/\s*\(.*?\)\s*/g, ' ').trim()} (cópia)`, builtIn: false }
  void router.push('/agents/new')
}

watch(creating, (value) => {
  if (!value) template.value = undefined
})
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <div>
      <p class="font-medium text-zinc-200">Só quem administra cria e edita agentes.</p>
      <p class="mt-1 text-sm">O gateway reconhece administrador pela identidade provada (<code>CALLER_PROOF_TOOL</code>) e por <code>ADMIN_ROLES</code> / <code>ADMIN_USERS</code>.</p>
    </div>
  </div>

  <div v-else class="flex h-full">
    <aside class="scroll-thin h-full w-full shrink-0 overflow-y-auto border-r border-zinc-800/80 lg:w-[320px]" :class="id || creating ? 'hidden lg:block' : 'block'">
      <header class="flex items-center gap-2 px-4 pt-4 pb-3">
        <h1 class="text-xl font-semibold">Agentes</h1>
        <RouterLink to="/agents/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Novo agente" @click="template = undefined"><Icon name="plus" class="h-5 w-5" /></RouterLink>
      </header>
      <template v-for="group in [{ label: 'Criados', items: created }, { label: 'Embutidos', items: builtIns }]" :key="group.label">
        <h2 v-if="group.items.length" class="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{{ group.label }}</h2>
        <RouterLink
          v-for="agent in group.items"
          :key="agent.id"
          :to="`/agents/${agent.id}`"
          class="mx-2 flex items-center gap-3 rounded-xl px-3 py-2.5"
          :class="agent.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'"
        >
          <AgentAvatar :name="agent.name" :provider="agent.provider" size="sm" />
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium">{{ agent.name }}</span>
            <span class="block truncate text-xs text-zinc-500">{{ PROVIDER_LABEL[agent.provider] }} · {{ agent.models[0] }}</span>
          </span>
        </RouterLink>
      </template>
      <p v-if="!created.length" class="px-4 py-2 text-sm text-zinc-500">Nenhum agente criado ainda.</p>
    </aside>

    <section class="scroll-thin h-full min-w-0 flex-1 overflow-y-auto px-4 py-5" :class="id || creating ? 'block' : 'hidden lg:block'">
      <RouterLink to="/agents" class="mb-3 inline-flex items-center gap-1 text-sm text-zinc-400 lg:hidden"><Icon name="back" class="h-4 w-4" /> Agentes</RouterLink>
      <template v-if="creating">
        <h2 class="mx-auto mb-4 max-w-3xl text-lg font-semibold">{{ template ? 'Duplicar agente' : 'Novo agente' }}</h2>
        <AgentForm :agent="template" creating @saved="(saved) => router.push(`/agents/${saved}`)" />
      </template>
      <template v-else-if="detail">
        <div class="mx-auto mb-4 flex max-w-3xl items-center gap-3">
          <AgentAvatar :name="detail.name" :provider="detail.provider" size="lg" />
          <div>
            <h2 class="text-lg font-semibold">{{ detail.name }}</h2>
            <p class="font-mono text-xs text-zinc-500">{{ detail.id }}</p>
          </div>
          <RouterLink :to="{ path: '/new', query: { agent: detail.id } }" class="ml-auto rounded-full bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">Conversar</RouterLink>
        </div>
        <AgentForm :agent="detail" :creating="false" @saved="(saved) => agents.detail(saved).then((fresh) => (detail = fresh))" @duplicate="duplicate" @removed="router.push('/agents')" />
      </template>
      <p v-else-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um agente ou crie um novo.</div>
    </section>
  </div>
</template>
