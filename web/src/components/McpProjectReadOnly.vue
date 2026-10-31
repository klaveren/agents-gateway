<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useRoute } from 'vue-router'
  import HistoryPanel from '@/components/HistoryPanel.vue'
  import HistoryTabs from '@/components/HistoryTabs.vue'
  import MasterDetail from '@/components/MasterDetail.vue'
  import { initials, redactUrl } from '@/lib/format'
  import type { TMcpAuth, TMcpKind, TMcpTransport } from '@/lib/types'
  import { useMcpStore } from '@/stores/mcp'
  import { useProjectsStore } from '@/stores/projects'

  /**
   * Os MCPs do projeto atual para o MEMBRO dele: SÓ LEITURA. ⛔ Nada de criar, editar, apagar, testar ou listar
   * ferramentas — tudo isso é de quem administra (a API responde 404). A lista vem de `?project=`: só os MCPs daquele
   * projeto, nunca os globais. A URL aparece sem segredo e a chave, só se está configurada (sem os últimos dígitos).
   */
  const props = defineProps<{ id?: string }>()

  const mcp = useMcpStore()
  const projects = useProjectsStore()
  const loadError = ref<string>()
  const route = useRoute()
  /** Detalhes ou o histórico do MCP — que o membro lê, sem restaurar (é de quem administra). */
  const tab = ref<'edit' | 'history'>(route.hash === '#historico' ? 'history' : 'edit')
  watch(
    () => props.id,
    () => (tab.value = route.hash === '#historico' ? 'history' : 'edit'),
  )

  const KIND_LABEL: Record<TMcpKind, string> = { process: 'Local (npm)', remote: 'Remoto (URL)', container: 'Contêiner isolado' }
  const TRANSPORT_LABEL: Record<TMcpTransport, string> = { auto: 'Automático', http: 'Streamable HTTP', sse: 'SSE' }
  const AUTH_LABEL: Record<TMcpAuth, string> = { caller: 'Login de quem conversa', header: 'Chave fixa', none: 'Nenhuma' }

  const selected = computed(() => (props.id ? mcp.list.find((server) => server.key === props.id) : undefined))

  // Trocou de projeto: a lista passa a ser a do novo (a de antes some, mesmo que a leitura falhe).
  watch(
    () => projects.current,
    async (project) => {
      mcp.list = []
      loadError.value = undefined
      if (!project) return
      try {
        await mcp.loadProject(project)
      } catch (error) {
        loadError.value = error instanceof Error ? error.message : String(error)
      }
    },
    { immediate: true },
  )
</script>

<template>
  <div v-if="!projects.current" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Você não está em nenhum projeto: peça a quem administra.</p>
  </div>

  <MasterDetail v-else :open="!!id" back-to="/mcp" back-label="MCPs" :title="selected?.name">
    <template #list>
      <header class="px-4 pt-4 pb-1">
        <h1 class="text-xl font-semibold">MCPs</h1>
      </header>
      <p class="px-4 pb-3 text-xs text-zinc-500">
        Os servidores de ferramentas do projeto {{ projects.currentProject?.name ?? projects.current }}. Só leitura: quem administra cadastra e edita.
      </p>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <p v-if="!mcp.list.length && !loadError" class="px-4 py-2 text-sm text-zinc-500">Este projeto não tem MCP próprio.</p>
      <RouterLink
        v-for="server in mcp.list"
        :key="server.key"
        :to="`/mcp/${server.key}`"
        class="mx-2 flex items-center gap-3 rounded-xl px-3 py-2"
        :class="[server.key === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60', { 'opacity-60': !server.enabled }]"
      >
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-500/20 text-xs font-semibold text-violet-200">{{ initials(server.name) }}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ server.name }}</span>
          <span class="block truncate text-xs text-zinc-500">{{ KIND_LABEL[server.kind] }} · {{ server.enabled ? 'ligado' : 'desligado' }}</span>
        </span>
      </RouterLink>
    </template>

    <template #detail>
      <section v-if="selected" :key="selected.key" data-test="mcp-readonly" class="mx-auto flex max-w-3xl flex-col gap-4">
        <div class="flex items-center gap-3">
          <span class="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-violet-500/20 text-base font-semibold text-violet-200">{{ initials(selected.name) }}</span>
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold">{{ selected.name }}</h2>
            <p class="truncate font-mono text-xs text-zinc-500">mcp:{{ selected.id }}/…</p>
          </div>
          <span class="ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs" :class="selected.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-400'">
            {{ selected.enabled ? 'Ligado' : 'Desligado' }}
          </span>
        </div>

        <HistoryTabs v-model="tab" edit-label="Detalhes" />
        <HistoryPanel v-if="tab === 'history'" kind="mcp" :id="selected.key" readonly />
        <template v-else>
          <dl class="grid gap-x-4 gap-y-2 rounded-xl border border-zinc-800 p-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt class="text-zinc-500">Identificador</dt>
            <dd class="font-mono text-zinc-200">{{ selected.id }}</dd>
            <dt class="text-zinc-500">Tipo</dt>
            <dd class="text-zinc-200">{{ KIND_LABEL[selected.kind] }}</dd>
            <template v-if="selected.kind === 'remote'">
              <dt class="text-zinc-500">URL</dt>
              <dd data-test="mcp-url" class="font-mono break-all text-zinc-200">{{ redactUrl(selected.url) }}</dd>
              <dt class="text-zinc-500">Conexão</dt>
              <dd class="text-zinc-200">{{ TRANSPORT_LABEL[selected.transport] }}</dd>
              <dt class="text-zinc-500">Autenticação</dt>
              <dd class="text-zinc-200">
                {{ AUTH_LABEL[selected.auth] }}
                <template v-if="selected.auth === 'header'">· {{ selected.secret.configured ? 'chave configurada' : 'sem chave' }}</template>
              </dd>
            </template>
            <template v-else-if="selected.kind === 'process' && selected.process?.package">
              <dt class="text-zinc-500">Pacote</dt>
              <dd class="font-mono break-all text-zinc-200">{{ selected.process.package }}</dd>
            </template>
            <template v-else-if="selected.kind === 'container' && selected.container?.image">
              <dt class="text-zinc-500">Imagem</dt>
              <dd class="font-mono break-all text-zinc-200">{{ selected.container.image }}</dd>
            </template>
            <dt class="text-zinc-500">Envia a identidade</dt>
            <dd class="text-zinc-200">{{ selected.identity ? 'Sim — agente, conversa e projeto nos cabeçalhos x-gateway-*' : 'Não' }}</dd>
            <dt class="text-zinc-500">Estado</dt>
            <dd class="text-zinc-200">
              {{
                selected.kind === 'remote'
                  ? selected.status.connected
                    ? 'conectado'
                    : 'sem conexão'
                  : `${selected.status.instances ?? 0} em execução`
              }}
            </dd>
            <dt class="text-zinc-500">Agentes</dt>
            <dd class="text-zinc-200">{{ selected.agents.length ? selected.agents.map((agent) => agent.name).join(', ') : 'nenhum ainda' }}</dd>
          </dl>

          <p class="text-xs text-zinc-500">As ferramentas que este servidor expõe, e o teste de conexão, ficam com quem administra.</p>
        </template>
      </section>
      <div v-else class="grid h-full place-items-center text-zinc-500">Escolha um MCP.</div>
    </template>
  </MasterDetail>
</template>
