<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { ApiError } from '@/lib/api'
  import { fullTime } from '@/lib/format'
  import { useResource } from '@/composables/useResource'
  import { useResourceSecretsStore } from '@/stores/resourceSecrets'
  import ConfirmDialog from './ConfirmDialog.vue'

  /**
   * A guia Variáveis (agente, skill ou command): segredos que o agente usa pelo NOME (`$GITLAB_TOKEN`) sem nunca ver o
   * valor. ⛔ O valor só ENTRA: nenhuma rota o devolve, então nenhum campo daqui nasce preenchido, e o campo é limpo
   * assim que a gravação volta. ⚠️ Mora DENTRO do formulário do agente/recurso: nada aqui é `<form>` nem submete com
   * Enter, e nenhum input tem validação nativa (`pattern`, `required`) — ela barraria o Salvar de quem está em volta.
   * Quem valida é o servidor (422 vira mensagem no campo); a dica do nome é só aviso.
   */
  const props = defineProps<{ basePath: string; scopeLabel: string; project?: string }>()
  const secrets = useResourceSecretsStore()
  /** `project`: os valores são DESTE projeto (skill/command): vai como `?project=` em todas as rotas. */
  const key = computed(() => (props.project ? `${props.basePath}?project=${encodeURIComponent(props.project)}` : props.basePath))

  const { data, error: listError } = useResource(secrets.lists, () => key.value)
  const list = computed(() => data.value ?? [])
  const NAME = /^[A-Z][A-Z0-9_]{1,63}$/

  const draft = ref({ name: '', description: '', value: '' })
  /** A variável com o valor sendo trocado, e a com a descrição sendo editada (uma de cada vez). */
  const changing = ref<string>()
  const newValue = ref('')
  const editing = ref<string>()
  const newDescription = ref('')
  const removing = ref<string>()
  const busy = ref(false)
  const error = ref<string>()
  const issues = ref<Record<string, string[]>>({})

  const nameHint = computed(() => (draft.value.name && !NAME.test(draft.value.name) ? 'Use letras MAIÚSCULAS, números e _ (começa com letra; 2 a 64 caracteres).' : undefined))
  const canAdd = computed(() => !!draft.value.name && !!draft.value.value && !busy.value)

  function describe(failure: unknown): string {
    if (failure instanceof ApiError && failure.status === 422) {
      const items = Array.isArray(failure.details) ? (failure.details as Array<{ field?: string; message?: string }>) : []
      return items.map((item) => (item.field ? `${item.field}: ${item.message}` : item.message)).join('; ') || failure.message
    }
    return failure instanceof Error ? failure.message : String(failure)
  }

  async function run(work: () => Promise<void>) {
    busy.value = true
    error.value = undefined
    issues.value = {}
    try {
      await work()
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 422) issues.value = failure.fieldIssues
      error.value = describe(failure)
    } finally {
      busy.value = false
    }
  }

  const add = () =>
    run(async () => {
      const description = draft.value.description.trim()
      try {
        await secrets.save(key.value, draft.value.name.trim(), { value: draft.value.value, ...(description ? { description } : {}) })
        draft.value = { name: '', description: '', value: '' }
      } finally {
        // ⛔ Deu certo ou não, o valor não fica na memória da tela.
        draft.value.value = ''
      }
    })

  function openChange(name: string) {
    newValue.value = ''
    changing.value = changing.value === name ? undefined : name
    editing.value = undefined
  }

  const saveValue = (name: string) =>
    run(async () => {
      try {
        await secrets.save(key.value, name, { value: newValue.value })
        changing.value = undefined
      } finally {
        newValue.value = ''
      }
    })

  function openDescription(name: string, current: string | undefined) {
    newDescription.value = current ?? ''
    editing.value = editing.value === name ? undefined : name
    changing.value = undefined
    newValue.value = ''
  }

  const saveDescription = (name: string) =>
    run(async () => {
      await secrets.save(key.value, name, { description: newDescription.value.trim() })
      editing.value = undefined
    })

  async function confirmedRemove() {
    const name = removing.value
    removing.value = undefined
    if (!name) return
    await run(() => secrets.remove(key.value, name))
  }
</script>

<template>
  <div class="flex flex-col gap-4" data-test="secret-variables">
    <div class="flex flex-col gap-1 text-xs text-zinc-500">
      <p>
        Variáveis secretas {{ scopeLabel }}. O agente vê só o NOME e usa
        <code class="text-zinc-300">$NOME</code>
        nos comandos; o valor vai no ambiente do comando e
        <strong class="text-zinc-300">nunca é mostrado de novo</strong>
        , nem aqui. Para trocar, digite o valor novo.
      </p>
      <p>Numa skill ou command, a variável só vale depois que ele é carregado na conversa. Comando que imprime o valor é recusado, e a saída que o contém sai mascarada.</p>
    </div>
    <p v-if="listError" class="text-sm text-rose-300">{{ describe(listError) }}</p>
    <p v-if="error" class="text-sm text-rose-300" data-test="secret-error">{{ error }}</p>

    <p v-if="!list.length" class="rounded-xl border border-dashed border-zinc-800 p-3 text-center text-sm text-zinc-500" data-test="secret-empty">Nenhuma variável ainda.</p>
    <ul v-else class="flex flex-col gap-2">
      <li v-for="secret in list" :key="secret.name" class="flex flex-col gap-2 rounded-xl border border-zinc-800 px-3 py-2.5" :data-secret="secret.name" data-test="secret-item">
        <div class="flex flex-wrap items-center gap-2">
          <code class="font-mono text-sm text-zinc-100" data-test="secret-name">{{ secret.name }}</code>
          <span class="flex-1" />
          <button type="button" class="btn btn-ghost" data-test="secret-change" @click="openChange(secret.name)">{{ secret.configured === false ? 'Definir valor' : 'Trocar valor' }}</button>
          <template v-if="secret.configured !== false">
            <button type="button" class="btn btn-ghost" data-test="secret-describe" @click="openDescription(secret.name, secret.description)">Descrição</button>
            <button type="button" class="btn btn-danger" data-test="secret-remove" @click="removing = secret.name">Apagar</button>
          </template>
        </div>
        <p v-if="secret.description" class="text-sm text-zinc-300">{{ secret.description }}</p>
        <p v-if="secret.configured === false || !secret.updatedAt" class="text-[11px] text-amber-300" data-test="secret-missing">Ainda sem valor neste projeto: a skill usa esta variável.</p>
        <p v-else class="text-[11px] text-zinc-500">
          Definida em {{ fullTime(secret.updatedAt) }}
          <template v-if="secret.updatedBy">por {{ secret.updatedBy }}</template>
          .
        </p>

        <div v-if="changing === secret.name" class="flex flex-wrap items-end gap-2">
          <label class="field min-w-0 flex-1">
            Novo valor
            <input v-model="newValue" type="password" autocomplete="new-password" class="input font-mono" data-test="secret-new-value" @keydown.enter.prevent />
          </label>
          <button type="button" class="btn btn-primary" :disabled="!newValue || busy" data-test="secret-save-value" @click="saveValue(secret.name)">Gravar valor</button>
        </div>
        <div v-if="editing === secret.name" class="flex flex-wrap items-end gap-2">
          <label class="field min-w-0 flex-1">
            Descrição
            <input v-model="newDescription" class="input" maxlength="300" data-test="secret-new-description" @keydown.enter.prevent />
          </label>
          <button type="button" class="btn btn-primary" :disabled="busy" data-test="secret-save-description" @click="saveDescription(secret.name)">Gravar descrição</button>
        </div>
      </li>
    </ul>

    <section class="flex flex-col gap-3 rounded-xl border border-zinc-800 p-3" data-test="secret-add">
      <h3 class="text-sm font-medium text-zinc-200">Adicionar variável</h3>
      <label class="field">
        Nome
        <input v-model="draft.name" class="input font-mono" placeholder="GITLAB_TOKEN" autocomplete="off" data-test="secret-add-name" @keydown.enter.prevent />
        <span v-if="nameHint" class="hint" data-test="secret-name-hint">{{ nameHint }}</span>
        <span v-for="message in issues.name ?? []" :key="message" class="error">{{ message }}</span>
      </label>
      <label class="field">
        Descrição (opcional)
        <input
          v-model="draft.description"
          class="input"
          maxlength="300"
          placeholder="Token da API do GitLab, escopo read_api"
          data-test="secret-add-description"
          @keydown.enter.prevent
        />
      </label>
      <label class="field">
        Valor
        <input v-model="draft.value" type="password" autocomplete="new-password" class="input font-mono" data-test="secret-add-value" @keydown.enter.prevent />
        <span v-for="message in issues.value ?? []" :key="message" class="error">{{ message }}</span>
      </label>
      <div>
        <button type="button" class="btn btn-primary" :disabled="!canAdd" data-test="secret-add-submit" @click="add">{{ busy ? 'Gravando…' : 'Adicionar' }}</button>
      </div>
    </section>

    <ConfirmDialog
      :open="!!removing"
      :title="`Apagar ${removing}?`"
      message="O valor é descartado e não dá para recuperá-lo. Quem usa esta variável deixa de enxergá-la."
      :busy="busy"
      @confirm="confirmedRemove"
      @cancel="removing = undefined"
    />
  </div>
</template>

<style scoped>
  @reference '../style.css';

  .field {
    @apply flex min-w-0 flex-col gap-1.5 text-sm font-medium text-zinc-300;
  }
  .input {
    @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
  }
  .hint {
    @apply text-xs font-normal text-zinc-500;
  }
  .error {
    @apply text-xs font-normal text-rose-300;
  }
</style>
