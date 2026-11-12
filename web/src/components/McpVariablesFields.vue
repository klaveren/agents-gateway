<script setup lang="ts">
  import { ref, watch } from 'vue'
  import { MCP_VAR_KIND_LABEL, mcpVarRows, mcpVarsOf, type IMcpVarRow, type TMcpVarKind, type TMcpVars } from '@/lib/mcpVars'

  /**
   * As variáveis do MCP, uma por linha, cada uma com o tipo: **Fixa** (o valor fica no MCP, igual em todo projeto), **Do
   * projeto** (cada projeto dá um valor visível) ou **Secreta do projeto** (cada projeto dá um valor secreto). ⛔ O MCP não
   * guarda segredo: os valores do projeto ficam em Ambiente → Variáveis, de cada projeto.
   * ⚠️ As linhas são locais (a que ainda não tem nome existe só aqui); o modelo recebe o que tem nome.
   */
  const model = defineModel<TMcpVars>({ required: true })
  defineProps<{ issues?: string[] }>()

  const rows = ref<IMcpVarRow[]>(mcpVarRows(model.value))
  // O cadastro trocou por fora (outro servidor, descartar): as linhas voltam a ser as dele.
  watch(model, (next) => {
    if (JSON.stringify(mcpVarsOf(rows.value)) !== JSON.stringify(mcpVarsOf(mcpVarRows(next)))) rows.value = mcpVarRows(next)
  })
  /** Os três campos sempre presentes: o que sumiu da lista sai do cadastro também. */
  const complete = (vars: TMcpVars): TMcpVars => ({ vars: vars.vars, projectVars: vars.projectVars, env: vars.env })
  const commit = () => {
    // O nome fica como vai ao servidor (maiúsculas, sem espaço): a linha mostra o que foi gravado.
    rows.value = rows.value.map((row) => ({ ...row, name: row.name.trim().toUpperCase() }))
    model.value = { ...model.value, ...complete(mcpVarsOf(rows.value)) }
  }

  function add() {
    rows.value = [...rows.value, { name: '', kind: 'secret', value: '' }]
  }
  function remove(index: number) {
    rows.value = rows.value.filter((_, at) => at !== index)
    commit()
  }
  function setKind(index: number, kind: TMcpVarKind) {
    rows.value = rows.value.map((row, at) => (at === index ? { ...row, kind, value: kind === 'fixed' ? row.value : '' } : row))
    commit()
  }
  const kinds = Object.entries(MCP_VAR_KIND_LABEL) as Array<[TMcpVarKind, string]>
</script>

<template>
  <div class="field" data-test="mcp-vars">
    <span>Variáveis de ambiente</span>
    <ul v-if="rows.length" class="flex flex-col gap-2">
      <li v-for="(row, index) in rows" :key="index" class="flex flex-wrap items-center gap-2" data-test="mcp-var-row">
        <input
          v-model="row.name"
          class="input w-44 shrink-0 font-mono text-xs uppercase"
          placeholder="NOME"
          autocomplete="off"
          aria-label="Nome da variável"
          data-test="mcp-var-name"
          @keydown.enter.prevent
          @change="commit"
        />
        <select
          :value="row.kind"
          class="input w-44 shrink-0 text-xs"
          aria-label="Tipo da variável"
          data-test="mcp-var-kind"
          @change="setKind(index, ($event.target as HTMLSelectElement).value as TMcpVarKind)"
        >
          <option v-for="[value, label] in kinds" :key="value" :value="value">{{ label }}</option>
        </select>
        <input
          v-if="row.kind === 'fixed'"
          v-model="row.value"
          class="input min-w-0 flex-1 font-mono text-xs"
          placeholder="valor (visível)"
          autocomplete="off"
          aria-label="Valor da variável fixa"
          data-test="mcp-var-value"
          @keydown.enter.prevent
          @change="commit"
        />
        <span v-else class="min-w-0 flex-1 text-xs font-normal text-zinc-500">{{ row.kind === 'secret' ? 'cada projeto dá o valor secreto' : 'cada projeto dá o valor' }}</span>
        <button type="button" class="btn btn-sm btn-ghost" :aria-label="`Remover ${row.name || 'a variável'}`" data-test="mcp-var-remove" @click="remove(index)">Remover</button>
      </li>
    </ul>
    <div>
      <button type="button" class="btn btn-sm btn-secondary" data-test="mcp-var-add" @click="add">Adicionar variável</button>
    </div>
    <small class="hint">
      Fixa: o valor fica aqui, igual para todos. Do projeto e Secreta do projeto: cada projeto preenche em
      <RouterLink to="/environment" class="text-emerald-400 underline underline-offset-2">Ambiente → Variáveis</RouterLink>; o valor vai só para este MCP, nunca
      para o terminal do agente.
    </small>
    <small v-for="message in issues ?? []" :key="message" class="error">{{ message }}</small>
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
