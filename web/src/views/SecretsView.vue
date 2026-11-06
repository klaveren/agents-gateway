<script setup lang="ts">
  import SaveFooter from '@/components/SaveFooter.vue'
import { computed, ref, watch } from 'vue'
  import { ApiError } from '@/lib/api'
  import { fullTime } from '@/lib/format'
  import { useResource } from '@/composables/useResource'
  import { useAuthStore } from '@/stores/auth'
  import { type ISecretHit, type ISecretValue, useSecretsStore } from '@/stores/secrets'

  /**
   * A MÁSCARA DE SEGREDOS (só admin): o que sai das ferramentas vai ao modelo, ao histórico e à tela, e passa antes por
   * três camadas — valor conhecido, forma (nome que diz segredo + valor opaco) e formato de token. Aqui se cadastram os
   * valores a mascarar (o valor entra e nunca volta), os nomes de campo extras, e se vê o que a máscara pegou. O que o
   * servidor devolve mora na store.
   */
  const LAYER: Record<ISecretHit['layer'], string> = { value: 'valor conhecido', shape: 'forma', format: 'formato' }

  const auth = useAuthStore()
  const store = useSecretsStore()
  const { data, error: loadError } = useResource(store.mask, () => (auth.isAdmin ? '' : undefined))
  const values = computed(() => data.value?.values ?? [])
  const hits = computed(() => data.value?.hits ?? [])
  /** Os nomes como a pessoa edita (um por linha); voltam ao salvo quando ele muda. */
  const secretNames = ref('')
  const safeNames = ref('')
  watch(
    () => data.value?.names,
    (names) => {
      secretNames.value = names?.secret.join('\n') ?? ''
      safeNames.value = names?.safe.join('\n') ?? ''
    },
    { immediate: true },
  )
  /** Os nomes mudaram e não foram gravados? (o rodapé fica disponível só então.) */
  const namesDirty = computed(
    () => secretNames.value !== (data.value?.names?.secret.join('\n') ?? '') || safeNames.value !== (data.value?.names?.safe.join('\n') ?? ''),
  )
  const draft = ref({ id: '', label: '', value: '' })
  const sample = ref('')
  const masked = ref<string>()
  const actionError = ref<string>()
  const error = computed(() => actionError.value ?? (loadError.value === undefined ? undefined : messageOf(loadError.value)))
  const notice = ref<string>()

  const messageOf = (failure: unknown) =>
    failure instanceof ApiError && Array.isArray(failure.details)
      ? (failure.details as Array<{ message: string }>).map((item) => item.message).join('; ')
      : failure instanceof Error
        ? failure.message
        : String(failure)

  async function addValue() {
    actionError.value = notice.value = undefined
    try {
      await store.saveValue(draft.value.id.trim(), draft.value.label, draft.value.value)
      notice.value = `"${draft.value.label}" passa a ser mascarado em tudo o que as conversas mostram e gravam.`
      draft.value = { id: '', label: '', value: '' }
    } catch (failure) {
      actionError.value = messageOf(failure)
    }
  }

  async function removeValue(value: ISecretValue) {
    if (!confirm(`Parar de mascarar "${value.label}"?`)) return
    actionError.value = undefined
    await store.removeValue(value.id).catch((failure) => (actionError.value = messageOf(failure)))
  }

  const lines = (text: string) =>
    text
      .split(/[\n,]+/)
      .map((line) => line.trim())
      .filter(Boolean)

  async function saveNames() {
    actionError.value = notice.value = undefined
    try {
      await store.saveNames({ secret: lines(secretNames.value), safe: lines(safeNames.value) })
      notice.value = 'Nomes salvos. Valem no próximo comando.'
    } catch (failure) {
      actionError.value = messageOf(failure)
    }
  }

  async function test() {
    masked.value = await store.test(sample.value).catch((failure: unknown) => messageOf(failure))
  }
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra vê a máscara de segredos.</p>
  </div>

  <div v-else class="h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header>
        <p class="text-xs text-zinc-500">O que sai das ferramentas vai ao modelo, ao histórico e à tela. Antes, passa por esta máscara.</p>
      </header>

      <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-300">
        <p><strong class="font-medium">Três camadas:</strong></p>
        <ol class="mt-1 list-decimal pl-5 text-zinc-400">
          <li>
            <strong class="text-zinc-300">Valor conhecido</strong>
            — as contas que foram ao comando, as chaves dos providers e os cadastrados aqui; também em base64 e a senha de uma URI.
          </li>
          <li>
            <strong class="text-zinc-300">Forma</strong>
            — nome que diz segredo (
            <code>…PASSWORD</code>
            ,
            <code>…TOKEN</code>
            ,
            <code>…API_KEY</code>
            ) com valor opaco, em JSON, YAML e .env.
          </li>
          <li>
            <strong class="text-zinc-300">Formato</strong>
            — tokens que se reconhecem sozinhos (GitHub, GitLab,
            <code>sk-</code>
            , AWS, Google, Slack, JWT, chave privada).
          </li>
        </ol>
        <p class="mt-1 text-zinc-500">
          O
          <code>kubectl get secret -o json|yaml</code>
          não roda. A máscara pega o vazamento sem querer, não o agente que quer vazar.
        </p>
      </div>
      <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <p v-if="notice" class="text-sm text-emerald-300">{{ notice }}</p>

      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-medium text-zinc-200">Valores a mascarar</h2>
        <ul v-if="values.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800 text-sm">
          <li v-for="value in values" :key="value.id" class="flex items-center gap-3 px-3 py-2">
            <span class="font-medium text-zinc-100">{{ value.label }}</span>
            <code class="text-xs text-zinc-500">{{ value.id }}</code>
            <span v-if="value.last4" class="text-xs text-zinc-500">…{{ value.last4 }}</span>
            <span class="ml-auto text-xs text-zinc-500">{{ value.updatedBy }} · {{ fullTime(value.updatedAt) }}</span>
            <button class="btn btn-ghost btn-sm text-rose-300" @click="removeValue(value)">Remover</button>
          </li>
        </ul>
        <p v-else class="text-xs text-zinc-500">Nenhum cadastrado. As contas dos projetos e as chaves dos providers já entram sozinhas.</p>
        <form class="grid gap-2 sm:grid-cols-[8rem_10rem_1fr_auto]" @submit.prevent="addValue">
          <input v-model="draft.id" class="input font-mono" placeholder="id" required />
          <input v-model="draft.label" class="input" placeholder="Nome (aparece na máscara)" required />
          <input v-model="draft.value" class="input font-mono" type="password" placeholder="O valor" autocomplete="off" required />
          <button class="btn btn-primary btn-sm" :disabled="!draft.id || !draft.label || !draft.value">Adicionar</button>
        </form>
      </section>

      <section class="grid gap-3 sm:grid-cols-2">
        <label class="field">
          Nomes que também dizem segredo
          <textarea v-model="secretNames" class="input font-mono text-xs" rows="4" placeholder="CHAVE_PIX&#10;BINANCE_SECRET" />
          <small class="hint">
            Um por linha; vale a parte do nome (
            <code>PIX</code>
            pega
            <code>CHAVE_PIX</code>
            ).
          </small>
        </label>
        <label class="field">
          Nomes que nunca são segredo
          <textarea v-model="safeNames" class="input font-mono text-xs" rows="4" placeholder="_HINT&#10;_LABEL" />
          <small class="hint">O fim do nome. Os de fábrica: HOST, PORT, URL, USER, NAME, ID, TIMEOUT…</small>
        </label>
      </section>

      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-medium text-zinc-200">Testar</h2>
        <textarea v-model="sample" class="input font-mono text-xs" rows="4" placeholder="Cole uma saída de comando, um .env, um JSON…" />
        <div><button class="btn btn-sm" :disabled="!sample.trim()" @click="test">Ver como sai</button></div>
        <pre v-if="masked !== undefined" class="max-h-60 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs whitespace-pre-wrap text-zinc-200">{{
          masked
        }}</pre>
      </section>

      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-medium text-zinc-200">Últimos acertos</h2>
        <ul v-if="hits.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800 text-xs">
          <li v-for="(hit, index) in hits" :key="index" class="flex gap-3 px-3 py-1.5">
            <span class="w-32 shrink-0 text-zinc-500">{{ fullTime(hit.at) }}</span>
            <span class="w-28 shrink-0 text-zinc-400">{{ LAYER[hit.layer] }}</span>
            <span class="min-w-0 flex-1 truncate text-zinc-200">{{ hit.label }}</span>
            <span class="shrink-0 text-zinc-500">{{ hit.length }} caracteres</span>
          </li>
        </ul>
        <p v-else class="text-xs text-zinc-500">Nada mascarado desde que o gateway subiu.</p>
      </section>
      <!-- Um salvar só por tela: os nomes. Os valores mascarados gravam na hora (Adicionar). -->
      <SaveFooter label="Salvar nomes" :disabled="!namesDirty" :pending="namesDirty" @save="saveNames" />
    </section>
  </div>
</template>

<style scoped>
  @reference '../style.css';

  /* O rótulo em cima do campo, com a dica embaixo, como nas outras telas. */
  .field {
    @apply flex min-w-0 flex-col gap-1.5 text-sm font-medium text-zinc-300;
  }
  .hint {
    @apply text-xs font-normal text-zinc-500;
  }
  .input {
    @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
  }
</style>
