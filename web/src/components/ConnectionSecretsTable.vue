<script setup lang="ts">
import { computed, ref } from 'vue'
import { parseEnvBlock } from '@/lib/envPaste'
import { useConnectionsStore } from '@/stores/connections'

/**
 * 🔌 AS VARIÁVEIS QUE O PROJETO CONECTADO PEDE, numa tela só: uma linha por NOME (o mesmo nome pedido por vários agentes
 * e recursos vale para todos), o status nesta máquina e o campo para preencher. Dá para colar um `.env` inteiro e
 * distribuir pelos nomes — é o que replica o ambiente entre quem se conecta ao mesmo projeto.
 *
 * ⛔ O valor só ENTRA: o servidor nunca o devolve, e o campo começa sempre vazio (vazio = fica como está).
 */
const props = defineProps<{ projectId: string }>()
const connections = useConnectionsStore()
const connection = computed(() => connections.byProject.get(props.projectId))

const KIND_LABEL: Record<string, string> = { agent: 'agente', skill: 'skill', command: 'comando' }

interface IRow {
  name: string
  description?: string
  users: string[]
  total: number
  filled: number
}

const rows = computed<IRow[]>(() => {
  const byName = new Map<string, IRow>()
  for (const secret of connection.value?.secrets ?? []) {
    const row = byName.get(secret.name) ?? { name: secret.name, users: [], total: 0, filled: 0 }
    row.users.push(`${KIND_LABEL[secret.kind] ?? secret.kind} ${secret.id}`)
    row.total += 1
    if (secret.configured) row.filled += 1
    if (!row.description && secret.description) row.description = secret.description
    byName.set(secret.name, row)
  }
  return [...byName.values()].sort((a, b) => Number(a.filled === a.total) - Number(b.filled === b.total) || a.name.localeCompare(b.name))
})
const pending = computed(() => rows.value.filter((row) => row.filled < row.total).length)

const values = ref<Record<string, string>>({})
const onlyPending = ref(false)
const pasting = ref(false)
const pasted = ref('')
const pasteNote = ref<string>()
const saving = ref(false)
const error = ref<string>()
const note = ref<string>()

const shown = computed(() => (onlyPending.value ? rows.value.filter((row) => row.filled < row.total) : rows.value))
const toSave = computed(() => Object.fromEntries(Object.entries(values.value).filter(([, value]) => value.trim() !== '')))
const count = computed(() => Object.keys(toSave.value).length)

function status(row: IRow): { label: string; tone: string } {
  if (row.filled === row.total) return { label: 'Preenchida', tone: 'bg-emerald-500/15 text-emerald-300' }
  if (row.filled > 0) return { label: `Parcial · ${row.filled} de ${row.total}`, tone: 'bg-amber-500/15 text-amber-200' }
  return { label: 'Pendente', tone: 'bg-zinc-700/50 text-zinc-300' }
}

/** O `.env` colado: cada nome que o projeto pede ganha o valor; o resto é só contado. O texto colado some em seguida. */
function applyPaste(): void {
  const parsed = parseEnvBlock(pasted.value)
  const asked = new Set(rows.value.map((row) => row.name))
  const used = Object.keys(parsed).filter((name) => asked.has(name))
  const ignored = Object.keys(parsed).filter((name) => !asked.has(name))
  for (const name of used) values.value[name] = parsed[name]!
  pasted.value = ''
  pasting.value = false
  pasteNote.value = `${used.length} preenchida(s) a partir do .env${ignored.length ? ` · ${ignored.length} ignorada(s), o projeto não pede: ${ignored.join(', ')}` : ''}. Revise e salve.`
}

async function save(): Promise<void> {
  saving.value = true
  error.value = undefined
  note.value = undefined
  try {
    const failed = await connections.setSecrets(props.projectId, toSave.value)
    const saved = count.value
    values.value = {}
    pasteNote.value = undefined
    note.value = failed.length
      ? `Gravadas, menos ${failed.length}: ${failed.map((item) => `${item.name} (${KIND_LABEL[item.kind] ?? item.kind} ${item.id}: ${item.message})`).join('; ')}`
      : `${saved} variável(is) gravada(s) nesta máquina.`
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <details v-if="rows.length" class="text-xs" data-test="connection-secrets">
    <summary class="cursor-pointer text-zinc-300">
      {{ rows.length }} variável(is) que o projeto pede
      <span v-if="pending" class="ml-1 rounded-full bg-amber-500/15 px-1.5 text-amber-200" data-test="secrets-pending">{{ pending }} pendente(s)</span>
      <span v-else class="ml-1 text-emerald-300">· todas preenchidas</span>
    </summary>
    <div class="mt-2 flex flex-col gap-2">
      <p class="text-zinc-500">
        Os valores ficam só nesta máquina. Cada nome vale para todo agente e recurso que o pede. Campo vazio fica como está; o valor salvo nunca é mostrado de volta.
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-1.5 text-zinc-300"><input v-model="onlyPending" type="checkbox" data-test="secrets-only-pending" /> Só as pendentes</label>
        <button type="button" class="btn btn-sm btn-ghost ml-auto" data-test="secrets-paste-toggle" @click="pasting = !pasting">Colar um .env</button>
      </div>
      <div v-if="pasting" class="flex flex-col gap-2">
        <textarea
          v-model="pasted"
          rows="5"
          class="input font-mono text-xs"
          spellcheck="false"
          autocomplete="off"
          placeholder="NOME=valor (uma por linha)"
          aria-label="Bloco .env"
          data-test="secrets-paste"
        />
        <div class="flex gap-2">
          <button type="button" class="btn btn-sm btn-secondary" :disabled="!pasted.trim()" data-test="secrets-paste-apply" @click="applyPaste">Distribuir pelos nomes</button>
          <button type="button" class="btn btn-sm btn-ghost" @click="((pasting = false), (pasted = ''))">Cancelar</button>
        </div>
      </div>
      <p v-if="pasteNote" class="text-sky-200" data-test="secrets-paste-note">{{ pasteNote }}</p>

      <div class="overflow-x-auto rounded-lg border border-zinc-800">
        <table class="w-full text-left">
          <thead class="bg-zinc-900/60 text-zinc-400">
            <tr>
              <th class="px-2 py-1.5 font-medium">Variável</th>
              <th class="px-2 py-1.5 font-medium">Status</th>
              <th class="w-2/5 px-2 py-1.5 font-medium">Valor</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-800">
            <tr v-for="row in shown" :key="row.name" :data-secret="row.name">
              <td class="px-2 py-1.5 align-top">
                <code class="text-zinc-100">{{ row.name }}</code>
                <p class="text-zinc-500">{{ row.users.join(' · ') }}<template v-if="row.description"> — {{ row.description }}</template></p>
              </td>
              <td class="px-2 py-1.5 align-top">
                <span class="rounded-full px-2 py-0.5 whitespace-nowrap" :class="status(row).tone" data-test="secret-status">{{ status(row).label }}</span>
              </td>
              <td class="px-2 py-1.5 align-top">
                <input
                  v-model="values[row.name]"
                  type="password"
                  autocomplete="new-password"
                  class="input h-8 w-full font-mono text-xs"
                  :placeholder="row.filled === row.total ? 'preenchida — digite para trocar' : 'valor'"
                  :aria-label="`Valor de ${row.name}`"
                  data-test="secret-input"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="error" class="text-rose-300" role="alert">{{ error }}</p>
      <p v-if="note" class="text-emerald-300" data-test="secrets-note">{{ note }}</p>
      <div class="flex justify-end">
        <button type="button" class="btn btn-sm btn-primary" :disabled="!count || saving" data-test="secrets-save" @click="save">
          {{ saving ? 'Salvando…' : count ? `Salvar ${count} variável(is)` : 'Salvar' }}
        </button>
      </div>
    </div>
  </details>
</template>
