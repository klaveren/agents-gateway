<script setup lang="ts">
  import { computed, onMounted, ref, watch } from 'vue'
  import { api, ApiError } from '@/lib/api'
  import { envDuplicates, envRecord, envRows, type IEnvRow } from '@/lib/agentForm'
  import type { IMcpProjectVariables } from '@/lib/types'
  import { useConnectionsStore } from '@/stores/connections'
  import { useProjectsStore } from '@/stores/projects'
  import ConfirmDialog from './ConfirmDialog.vue'
  import ConnectedReadOnly from './ConnectedReadOnly.vue'
  import SaveFooter from './SaveFooter.vue'
  import SecretVariables from './SecretVariables.vue'

  /**
   * As VARIÁVEIS do projeto: as **Fixas** (valor visível) e as **Secretas** (o valor só entra) chegam ao terminal de todo
   * agente nas conversas do projeto, por baixo das do agente (a dele vence a de mesmo nome). Os **MCPs** que pedem valor ao
   * projeto aparecem embaixo: esse valor vai só para o processo do MCP, nunca para o terminal do agente.
   * 🔌 Projeto conectado: as fixas e os valores visíveis vêm da origem (só leitura); as secretas e as **fixas desta
   * máquina** (por cima das da origem, nunca vão para lá) são daqui.
   * ⚖️ As fixas vão com o Salvar do rodapé; cada secreta e cada valor de MCP é gravado na hora, como no agente.
   */
  const props = defineProps<{ projectId: string; active?: boolean }>()
  const projects = useProjectsStore()
  const connections = useConnectionsStore()
  const connectedOrigin = computed(() => connections.originOf(props.projectId))
  const project = computed(() => projects.list.find((item) => item.id === props.projectId))

  const fixed = ref<IEnvRow[]>(envRows(project.value?.env))
  const savedFixed = computed(() => JSON.stringify(envRecord(envRows(project.value?.env))))
  const fixedDirty = computed(() => JSON.stringify(envRecord(fixed.value)) !== savedFixed.value)
  const repeated = computed(() => envDuplicates(fixed.value))
  // O projeto foi relido (outra tela salvou): sem mudança local pendente, as linhas acompanham.
  watch(
    () => project.value?.env,
    (env) => {
      if (!fixedDirty.value) fixed.value = envRows(env)
    },
  )

  // 🔌 As fixas desta máquina (projeto conectado): por cima das da origem, com o mesmo Salvar.
  const connection = computed(() => connections.list.find((item) => item.projectId === props.projectId))
  const local = ref<IEnvRow[]>(envRows(connection.value?.localEnv))
  const savedLocal = computed(() => JSON.stringify(envRecord(envRows(connection.value?.localEnv))))
  const localDirty = computed(() => JSON.stringify(envRecord(local.value)) !== savedLocal.value)
  const localRepeated = computed(() => envDuplicates(local.value))
  watch(
    () => connection.value?.localEnv,
    (env) => {
      if (!localDirty.value) local.value = envRows(env)
    },
  )

  const busy = ref(false)
  const note = ref<string>()
  const failure = ref<string>()
  const fixedIssues = ref<string[]>([])

  function describe(error: unknown): string {
    if (error instanceof ApiError && error.status === 422) {
      const items = Array.isArray(error.details) ? (error.details as Array<{ message?: string }>) : []
      return items.map((item) => item.message).join('; ') || error.message
    }
    return error instanceof Error ? error.message : String(error)
  }

  async function saveFixed() {
    busy.value = true
    note.value = failure.value = undefined
    fixedIssues.value = []
    try {
      await projects.update(props.projectId, { env: envRecord(fixed.value) ?? {} })
      fixed.value = envRows(project.value?.env)
      note.value = 'Variáveis fixas salvas. Valem nos próximos comandos dos agentes do projeto.'
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) fixedIssues.value = [describe(error)]
      else failure.value = describe(error)
    } finally {
      busy.value = false
    }
  }

  async function saveLocal() {
    busy.value = true
    note.value = failure.value = undefined
    fixedIssues.value = []
    try {
      await connections.setLocalEnv(props.projectId, envRecord(local.value) ?? {})
      local.value = envRows(connection.value?.localEnv)
      note.value = 'Variáveis desta máquina salvas. Valem nos próximos comandos dos agentes do projeto.'
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) fixedIssues.value = [describe(error)]
      else failure.value = describe(error)
    } finally {
      busy.value = false
    }
  }

  // --- Os MCPs que pedem valor ao projeto -------------------------------------------------------------------------
  const mcps = ref<IMcpProjectVariables[]>([])
  const mcpError = ref<string>()
  /** O que se digitou em cada variável (`<servidor>/<nome>`). ⛔ O da secreta é limpo assim que a gravação volta. */
  const drafts = ref<Record<string, string>>({})
  const removing = ref<{ server: string; name: string }>()
  /** As gravações dos MCPs, à parte do Salvar das fixas (o rodapé não diz "Salvando…" por elas). */
  const mcpBusy = ref(false)
  const base = computed(() => `/projects/${encodeURIComponent(props.projectId)}/mcp-variables`)
  const keyOf = (server: string, name: string) => `${server}/${name}`

  async function loadMcps() {
    mcpError.value = undefined
    try {
      mcps.value = await api<IMcpProjectVariables[]>(base.value)
      drafts.value = Object.fromEntries(
        mcps.value.flatMap((server) => server.variables.filter((variable) => !variable.secret).map((variable) => [keyOf(server.id, variable.name), variable.value ?? ''])),
      )
    } catch (error) {
      mcpError.value = describe(error)
    }
  }
  onMounted(loadMcps)

  async function saveMcp(server: string, name: string, secret: boolean) {
    const key = keyOf(server, name)
    mcpBusy.value = true
    mcpError.value = undefined
    try {
      const saved = await api<IMcpProjectVariables>(`${base.value}/${encodeURIComponent(server)}/${encodeURIComponent(name)}`, { method: 'PUT', body: { value: drafts.value[key] ?? '' } })
      mcps.value = mcps.value.map((item) => (item.id === saved.id ? saved : item))
    } catch (error) {
      mcpError.value = describe(error)
    } finally {
      // ⛔ O valor secreto não fica na memória da tela, deu certo ou não.
      if (secret) drafts.value = { ...drafts.value, [key]: '' }
      mcpBusy.value = false
    }
  }

  async function confirmedRemove() {
    const target = removing.value
    removing.value = undefined
    if (!target) return
    mcpBusy.value = true
    mcpError.value = undefined
    try {
      await api(`${base.value}/${encodeURIComponent(target.server)}/${encodeURIComponent(target.name)}`, { method: 'DELETE' })
      await loadMcps()
    } catch (error) {
      mcpError.value = describe(error)
    } finally {
      mcpBusy.value = false
    }
  }
</script>

<template>
  <div class="flex flex-col gap-3" data-test="project-variables">
    <ConnectedReadOnly v-if="connectedOrigin" :origin="connectedOrigin" />
    <p v-if="connectedOrigin" class="text-xs text-zinc-500">As fixas desta máquina, as secretas e os valores secretos dos MCPs são daqui: nunca vão para a origem.</p>

    <section class="tool-card">
      <header>
        <h3>{{ connectedOrigin ? 'Fixas da origem' : 'Fixas' }}</h3>
        <span class="count">{{ fixed.length || 'nenhuma' }} · {{ connectedOrigin ? 'só leitura aqui' : 'salvas com o botão Salvar' }}</span>
      </header>
      <fieldset :disabled="!!connectedOrigin" class="flex flex-col gap-2 p-3">
        <p class="hint">
          Texto comum, no terminal de todo agente nas conversas deste projeto (o dele e o dos CLIs): endereço de um serviço, região, idioma. A fixa do agente vence a
          de mesmo nome. Segredo não mora aqui: vai em Secretas, logo abaixo.
        </p>
        <div v-for="(row, index) in fixed" :key="index" class="flex flex-wrap items-center gap-2" data-test="project-fixed-row">
          <input v-model="row.name" class="input w-56 font-mono text-xs" placeholder="API_BASE_URL" :aria-label="`Nome da variável ${index + 1}`" @keydown.enter.prevent />
          <input v-model="row.value" class="input min-w-0 flex-1 font-mono text-xs" placeholder="valor" :aria-label="`Valor da variável ${index + 1}`" @keydown.enter.prevent />
          <button v-if="!connectedOrigin" type="button" class="btn btn-sm btn-danger" @click="fixed.splice(index, 1)">Remover</button>
        </div>
        <button v-if="!connectedOrigin" type="button" class="btn btn-sm btn-ghost self-start" data-test="project-fixed-add" @click="fixed.push({ name: '', value: '' })">+ Variável</button>
        <small v-for="name in repeated" :key="`dup-${name}`" class="error">{{ name }} aparece mais de uma vez</small>
        <small v-for="message in connectedOrigin ? [] : fixedIssues" :key="message" class="error" data-test="project-fixed-error">{{ message }}</small>
      </fieldset>
    </section>

    <section v-if="connectedOrigin" class="tool-card" data-test="project-local-fixed">
      <header>
        <h3>Fixas desta máquina</h3>
        <span class="count">{{ local.length || 'nenhuma' }} · salvas com o botão Salvar · nunca vão para a origem</span>
      </header>
      <div class="flex flex-col gap-2 p-3">
        <p class="hint">
          Texto comum, só neste gateway: o endereço de um serviço daqui, a porta local. Valem por cima das fixas da origem (a de mesmo nome vence) e por baixo das do
          agente. Ao desconectar, passam para o projeto. Segredo não mora aqui: vai em Secretas.
        </p>
        <div v-for="(row, index) in local" :key="index" class="flex flex-wrap items-center gap-2" data-test="project-local-row">
          <input v-model="row.name" class="input w-56 font-mono text-xs" placeholder="API_BASE_URL" :aria-label="`Nome da variável desta máquina ${index + 1}`" @keydown.enter.prevent />
          <input v-model="row.value" class="input min-w-0 flex-1 font-mono text-xs" placeholder="valor" :aria-label="`Valor da variável desta máquina ${index + 1}`" @keydown.enter.prevent />
          <button type="button" class="btn btn-sm btn-danger" @click="local.splice(index, 1)">Remover</button>
        </div>
        <button type="button" class="btn btn-sm btn-ghost self-start" data-test="project-local-add" @click="local.push({ name: '', value: '' })">+ Variável</button>
        <small v-for="name in localRepeated" :key="`dup-${name}`" class="error">{{ name }} aparece mais de uma vez</small>
        <small v-for="message in fixedIssues" :key="message" class="error" data-test="project-local-error">{{ message }}</small>
      </div>
    </section>

    <section class="tool-card">
      <header>
        <h3>Secretas</h3>
        <span class="count">cifradas · cada uma é gravada na hora, à parte do Salvar</span>
      </header>
      <div class="p-3">
        <SecretVariables :load-note="false" :base-path="`/projects/${encodeURIComponent(projectId)}`" scope-label="do projeto, para todo agente nas conversas dele (a do agente vence a de mesmo nome)" />
      </div>
    </section>

    <section class="tool-card" data-test="project-mcp-variables">
      <header>
        <h3>MCPs</h3>
        <span class="count">o valor vai só para o processo do MCP, nunca para o terminal do agente</span>
      </header>
      <div class="flex flex-col gap-3 p-3">
        <p v-if="mcpError" class="text-sm text-rose-300" data-test="project-mcp-error">{{ mcpError }}</p>
        <p v-if="!mcps.length" class="text-sm text-zinc-500">Nenhum MCP pede valor a este projeto. Quem declara é o MCP, na guia MCPs: variável "Do projeto" ou "Secreta do projeto".</p>
        <article v-for="server in mcps" :key="server.key" class="flex flex-col gap-2 rounded-xl border border-zinc-800 px-3 py-2.5" :data-mcp="server.id">
          <div class="flex flex-wrap items-baseline gap-2">
            <span class="text-sm font-medium text-zinc-100">{{ server.name }}</span>
            <code class="text-xs text-zinc-500">{{ server.id }}</code>
            <span v-if="!server.enabled" class="text-xs text-amber-300">desligado</span>
            <span v-if="server.fixed.length" class="ml-auto text-xs text-zinc-500">fixas no MCP: {{ server.fixed.join(', ') }}</span>
          </div>
          <div v-for="variable in server.variables" :key="variable.name" class="flex flex-wrap items-center gap-2" :data-variable="variable.name">
            <code class="w-44 shrink-0 font-mono text-xs text-zinc-200">{{ variable.name }}</code>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px]" :class="variable.secret ? 'bg-violet-500/15 text-violet-300' : 'bg-zinc-800 text-zinc-300'">
              {{ variable.secret ? 'secreta' : 'visível' }}
            </span>
            <template v-if="variable.secret">
              <input
                v-model="drafts[keyOf(server.id, variable.name)]"
                type="password"
                autocomplete="new-password"
                class="input min-w-0 flex-1 font-mono text-xs"
                :placeholder="variable.configured ? 'preenchida — digite para trocar' : 'sem valor'"
                :aria-label="`Valor secreto de ${variable.name}`"
                data-test="project-mcp-secret"
                @keydown.enter.prevent
              />
              <button type="button" class="btn btn-sm btn-primary" :disabled="mcpBusy || !drafts[keyOf(server.id, variable.name)]" @click="saveMcp(server.id, variable.name, true)">
                Gravar valor
              </button>
            </template>
            <template v-else>
              <input
                v-model="drafts[keyOf(server.id, variable.name)]"
                :disabled="!!connectedOrigin"
                class="input min-w-0 flex-1 font-mono text-xs"
                placeholder="sem valor"
                :aria-label="`Valor de ${variable.name}`"
                data-test="project-mcp-visible"
                @keydown.enter.prevent
              />
              <button
                v-if="!connectedOrigin"
                type="button"
                class="btn btn-sm btn-primary"
                :disabled="mcpBusy || !drafts[keyOf(server.id, variable.name)] || drafts[keyOf(server.id, variable.name)] === variable.value"
                @click="saveMcp(server.id, variable.name, false)"
              >
                Gravar
              </button>
            </template>
            <button
              v-if="variable.configured && (variable.secret || !connectedOrigin)"
              type="button"
              class="btn btn-sm btn-danger"
              :disabled="mcpBusy"
              @click="removing = { server: server.id, name: variable.name }"
            >
              Apagar
            </button>
          </div>
        </article>
      </div>
    </section>

    <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
    <p v-if="failure" class="text-sm text-rose-300">{{ failure }}</p>
    <SaveFooter v-if="!connectedOrigin" v-show="active !== false" label="Salvar variáveis fixas" :busy="busy" :disabled="!fixedDirty || !!repeated.length" :pending="fixedDirty" @save="saveFixed" />
    <SaveFooter
      v-else
      v-show="active !== false"
      label="Salvar variáveis desta máquina"
      :busy="busy"
      :disabled="!localDirty || !!localRepeated.length"
      :pending="localDirty"
      @save="saveLocal"
    />

    <ConfirmDialog
      :open="!!removing"
      :title="`Apagar o valor de ${removing?.name}?`"
      message="O MCP passa a subir sem esta variável neste projeto. O valor secreto não dá para recuperar."
      :busy="mcpBusy"
      @confirm="confirmedRemove"
      @cancel="removing = undefined"
    />
  </div>
</template>

<style scoped>
  @reference '../style.css';

  .tool-card {
    @apply rounded-xl border border-zinc-800;
  }
  .tool-card > header {
    @apply flex flex-wrap items-baseline gap-2 border-b border-zinc-800 px-3 py-2;
  }
  .tool-card h3 {
    @apply text-sm font-medium text-zinc-200;
  }
  .tool-card .count {
    @apply text-xs text-zinc-500;
  }
  .input {
    @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60 disabled:opacity-60;
  }
  .hint {
    @apply text-xs text-zinc-500;
  }
  .error {
    @apply text-xs font-normal text-rose-300;
  }
</style>
