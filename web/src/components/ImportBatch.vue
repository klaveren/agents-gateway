<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { tokens } from '@/lib/format'
import {
  EXCLUSION_LABEL,
  exclusionsByReason,
  ID_STATE_LABEL,
  type IImportPlan,
  KIND_LABEL,
  prefixIssue,
  REACH_MARK,
  REACH_STATUS_LABEL,
  reachRows,
  stepsByPhase,
  WHY_LABEL,
} from '@/lib/importer'

/**
 * O LOTE de um agente: o fecho em ordem por fase, o mapa de ids (com o prefixo), a tabela de permissões ✅/⚠️/❌ com as
 * ampliações em destaque, o que fica de fora e a estimativa. ⛔ Só mostra: nenhum botão grava nem dispara construtor —
 * o dono opera a importação item a item, mais adiante.
 */
const props = defineProps<{ plan: IImportPlan; busy?: boolean }>()
const emit = defineEmits<{ close: []; select: [key: string]; replan: [prefix: string] }>()

const prefix = ref(props.plan.prefix)
watch(
  () => props.plan.prefix,
  (value) => (prefix.value = value),
)
const issue = computed(() => prefixIssue(prefix.value))

const groups = computed(() => stepsByPhase(props.plan))
const rows = computed(() => reachRows(props.plan))
const exclusions = computed(() => exclusionsByReason(props.plan.excluded))
const later = computed(() => props.plan.phases.filter((phase) => phase.phase >= 5))
const widenings = computed(() => [
  ...(props.plan.reach?.translation.widenings ?? []).map((item) => ({ ...item, layer: 'agente' })),
  ...(props.plan.project?.widenings ?? []).map((item) => ({ ...item, layer: 'projeto' })),
])
const changedIds = computed(() => props.plan.idMap.filter((entry) => entry.prefixed || entry.state !== 'new' || entry.cut))
const position = computed(() => new Map(props.plan.steps.map((step, at) => [step.key, at + 1])))
const totals = computed(() => props.plan.reach?.translation.totals)

const ruleText = (rule: { category: string; pattern: string; decision: string }) => `${rule.category} ${rule.decision === 'allow' ? 'libera' : 'nega'} ${rule.pattern}`
</script>

<template>
  <section class="flex flex-col gap-4 rounded-xl border border-emerald-500/30 p-3 text-sm" data-test="batch">
    <header class="flex flex-wrap items-start gap-2">
      <div class="min-w-0 flex-1">
        <h2 class="text-base font-semibold text-zinc-100">
          Lote de <code class="text-emerald-200">{{ plan.agent }}</code>
        </h2>
        <p class="text-xs text-zinc-500">Só leitura: o lote mostra o que a importação faria, na ordem. Nada é gravado e nenhum construtor é disparado.</p>
      </div>
      <form class="flex items-end gap-2" @submit.prevent="!issue && emit('replan', prefix.trim().toLowerCase())">
        <label class="field w-36">
          Prefixo dos ids
          <input v-model="prefix" class="input" placeholder="sem prefixo" maxlength="16" data-test="prefix" />
        </label>
        <button type="submit" class="btn btn-secondary btn-sm mb-0.5" :disabled="busy || !!issue" data-test="replan">{{ busy ? 'Montando…' : 'Recalcular' }}</button>
        <button type="button" class="btn btn-ghost btn-sm mb-0.5" @click="emit('close')">Fechar</button>
      </form>
    </header>
    <p v-if="issue" class="text-xs text-rose-300">Prefixo: {{ issue }}</p>

    <section v-if="plan.blocked.length" class="rounded-xl border border-rose-500/50 bg-rose-500/10 px-3 py-2" data-test="blocked">
      <h3 class="text-xs font-semibold tracking-wide text-rose-200 uppercase">Bloqueado: id em conflito</h3>
      <p class="text-xs text-rose-100/80">Mude o id (o prefixo, por exemplo) antes de transformar.</p>
      <ul class="mt-1 flex flex-col gap-0.5 text-xs text-rose-50">
        <li v-for="line in plan.blocked" :key="line">{{ line }}</li>
      </ul>
    </section>

    <section class="flex flex-col gap-1 rounded-xl border border-zinc-800 px-3 py-2" data-test="estimate">
      <h3 class="text-xs font-medium text-zinc-500">Estimativa</h3>
      <p class="text-zinc-200">
        <strong>{{ plan.estimate.conversations }}</strong> conversa(s) de construtor · ≈<strong>{{ tokens(plan.estimate.inputTokens) }}</strong> tokens de entrada
        <span class="text-xs text-zinc-500">({{ tokens(plan.estimate.sourceTokens) }} das fontes + {{ tokens(plan.estimate.protocolTokens) }} do protocolo)</span>
      </p>
      <p class="flex flex-wrap gap-x-3 text-xs text-zinc-400">
        <span v-for="(entry, kind) in plan.estimate.byKind" :key="kind">{{ KIND_LABEL[kind] }}: {{ entry!.conversations }} · ≈{{ tokens(entry!.inputTokens) }}</span>
      </p>
      <p v-if="plan.estimate.released.conversations" class="text-xs text-zinc-500">
        Incluir as {{ plan.estimate.released.conversations }} skill(s) liberadas e não citadas somaria ≈{{ tokens(plan.estimate.released.inputTokens) }} tokens.
      </p>
      <p class="text-xs text-zinc-500">{{ plan.estimate.note }}.</p>
    </section>

    <section class="flex flex-col gap-2" data-test="order">
      <h3 class="text-xs font-medium text-zinc-500">Ordem ({{ plan.steps.length }} itens com conversa, depois vínculos e permissões)</h3>
      <div v-for="group in groups" :key="group.phase" class="flex flex-col gap-1">
        <h4 class="text-xs font-semibold text-zinc-300">Fase {{ group.phase }} · {{ group.label }} · {{ group.steps.length }}</h4>
        <ol class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
          <li v-for="step in group.steps" :key="step.key" class="flex flex-col gap-0.5 px-3 py-1.5" data-test="step">
            <span class="flex flex-wrap items-center gap-2">
              <span class="w-7 shrink-0 text-right font-mono text-xs text-zinc-500">{{ position.get(step.key) }}</span>
              <span class="rounded-full border border-zinc-700 px-2 text-[11px] text-zinc-400">{{ KIND_LABEL[step.kind] }}</span>
              <button type="button" class="min-w-0 font-mono text-sm break-all text-zinc-100 hover:underline" @click="emit('select', step.key)">{{ step.id }}</button>
              <span v-if="step.state !== 'new'" class="rounded-full border px-2 text-[11px]" :class="step.state === 'update' ? 'border-zinc-700 text-zinc-400' : 'border-rose-500/50 text-rose-200'">{{ ID_STATE_LABEL[step.state] }}</span>
              <span v-if="step.notes.some((note) => note.level === 'untranslatable')" class="rounded-full bg-amber-500/15 px-2 text-[11px] text-amber-200">não traduz</span>
              <span class="text-xs text-zinc-500">{{ WHY_LABEL[step.why] }} · ≈{{ tokens(step.tokens.sources + step.tokens.protocol) }}</span>
            </span>
            <span v-if="step.dependsOn.length || step.forward.length" class="pl-9 text-xs break-all text-zinc-500">
              <template v-if="step.dependsOn.length">depois de {{ step.dependsOn.join(', ') }}</template>
              <template v-if="step.forward.length"> · cita adiante {{ step.forward.join(', ') }}</template>
            </span>
          </li>
        </ol>
      </div>
      <ul class="flex flex-col gap-0.5 text-xs text-zinc-400">
        <li v-for="phase in later" :key="phase.phase">
          Fase {{ phase.phase }} · {{ phase.label }}
          <template v-if="phase.phase === 5"> · {{ plan.links.length }} vínculo(s)</template>
          <template v-else-if="phase.phase === 6"> · {{ plan.reach ? `${plan.reach.translation.rules.length} regra(s), ${plan.reach.translation.allowedTools.length} ferramenta(s)` : 'nada a traduzir' }}</template>
          <template v-else> · {{ plan.project ? `${plan.project.lines.length} linha(s)` : 'nada' }}</template>
        </li>
      </ul>
    </section>

    <section v-if="plan.cycles.length" class="flex flex-col gap-1" data-test="cycles">
      <h3 class="text-xs font-medium text-zinc-500">Ciclos ({{ plan.cycles.length }})</h3>
      <p v-for="cycle in plan.cycles" :key="cycle.keys.join()" class="text-xs break-words text-amber-200">{{ cycle.text }}</p>
    </section>

    <section class="flex flex-col gap-1" data-test="id-map">
      <h3 class="text-xs font-medium text-zinc-500">Mapa de ids ({{ plan.idMap.length }}{{ plan.prefix ? `, prefixo ${plan.prefix}` : ', sem prefixo' }})</h3>
      <p v-if="!changedIds.length" class="text-xs text-zinc-500">Todos os ids ficam como na origem, e são novos no catálogo.</p>
      <table v-else class="w-full text-left text-xs">
        <thead class="text-zinc-500">
          <tr>
            <th class="py-1 pr-2 font-medium">Origem</th>
            <th class="py-1 pr-2 font-medium">No gateway</th>
            <th class="py-1 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-800">
          <tr v-for="entry in changedIds" :key="entry.key" :class="entry.state === 'conflict' || entry.state === 'duplicate' ? 'text-rose-200' : 'text-zinc-300'">
            <td class="py-1 pr-2 font-mono break-all">{{ entry.key }}</td>
            <td class="py-1 pr-2 font-mono break-all">{{ entry.parent ? `${entry.parent}/` : '' }}{{ entry.id }}</td>
            <td class="py-1">{{ ID_STATE_LABEL[entry.state] }}<span v-if="entry.reason" class="text-zinc-500"> — {{ entry.reason }}</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="plan.links.length" class="flex flex-col gap-1" data-test="links">
      <h3 class="text-xs font-medium text-zinc-500">Vínculos de delegação (fase 5)</h3>
      <ul class="flex flex-col gap-0.5 text-xs">
        <li v-for="link in plan.links" :key="link.name" :class="link.state === 'exists' ? 'text-zinc-300' : 'text-zinc-400'">
          <code>{{ link.name }}</code> → <code>{{ link.id }}</code> <span v-if="link.cycle" class="text-amber-200">(ciclo)</span> — {{ link.text }}
        </li>
      </ul>
    </section>

    <section v-if="widenings.length" class="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2" data-test="widenings">
      <h3 class="text-xs font-semibold tracking-wide text-amber-200 uppercase">Ampliações ({{ widenings.length }})</h3>
      <p class="text-xs text-amber-100/80">Cada uma precisa da confirmação da pessoa, uma a uma, na gravação. Nenhuma entra sozinha.</p>
      <ul class="mt-1 flex flex-col gap-0.5 text-xs text-amber-50">
        <li v-for="item in widenings" :key="`${item.layer} ${ruleText(item.rule)}`">
          <span class="text-amber-300">{{ item.layer }}</span> <code>{{ ruleText(item.rule) }}</code> — {{ item.reason }}
        </li>
      </ul>
      <ul v-if="plan.project?.notes.some((note) => note.level !== 'info')" class="mt-1 text-xs text-amber-100">
        <li v-for="note in plan.project!.notes.filter((one) => one.level !== 'info')" :key="note.code">{{ note.text }}</li>
      </ul>
    </section>

    <section class="flex flex-col gap-1.5" data-test="reach">
      <h3 class="text-xs font-medium text-zinc-500">
        Permissões (fases 6 e 7)
        <template v-if="totals"> · {{ REACH_MARK.direct }} {{ totals.direct }} · {{ REACH_MARK.changed }} {{ totals.changed }} · {{ REACH_MARK.none }} {{ totals.none }}</template>
      </h3>
      <p v-if="!plan.reach" class="text-xs text-zinc-500">{{ plan.notes.find((note) => note.code === 'reach-none')?.text ?? 'Sem alcance para traduzir.' }}</p>
      <template v-else>
        <p class="text-xs text-zinc-500">Bloco <code>{{ plan.reach.sourceName }}</code> do opencode. {{ plan.reach.notes.find((note) => note.code === 'reach-closed')?.text }}.</p>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[40rem] text-left text-xs">
            <thead class="text-zinc-500">
              <tr>
                <th class="py-1 pr-2 font-medium" />
                <th class="py-1 pr-2 font-medium">Camada</th>
                <th class="py-1 pr-2 font-medium">Origem</th>
                <th class="py-1 pr-2 font-medium">No gateway</th>
                <th class="py-1 font-medium">Motivo</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-800">
              <tr v-for="(row, at) in rows" :key="at" :class="row.widening ? 'bg-amber-500/10 text-amber-50' : 'text-zinc-300'" data-test="reach-row">
                <td class="py-1 pr-2" :title="REACH_STATUS_LABEL[row.status]">{{ REACH_MARK[row.status] }}</td>
                <td class="py-1 pr-2 text-zinc-500">{{ row.layer }}</td>
                <td class="py-1 pr-2 font-mono break-all">{{ row.key }} {{ row.pattern }} {{ row.action }}</td>
                <td class="py-1 pr-2 font-mono break-all">
                  <template v-if="row.rules.length"><div v-for="rule in row.rules" :key="ruleText(rule)">{{ ruleText(rule) }}</div></template>
                  <span v-else class="text-zinc-500">—</span>
                </td>
                <td class="py-1 break-words">
                  <span v-if="row.widening" class="font-medium text-amber-200">ampliação: {{ row.widening }}. </span>{{ row.reason }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="plan.reach.translation.tools.length" class="text-xs text-zinc-400">
          <p class="font-medium text-zinc-500">tools → allowedTools</p>
          <p v-for="tool in plan.reach.translation.tools" :key="tool.key">
            {{ REACH_MARK[tool.status] }} <code>{{ tool.key }}: {{ tool.enabled }}</code>
            <template v-if="tool.tools.length"> → <code>{{ tool.tools.join(', ') }}</code></template>
            <span v-if="tool.reason" class="text-zinc-500"> — {{ tool.reason }}</span>
          </p>
        </div>
        <p class="text-xs text-zinc-300" data-test="allowed-tools">
          allowedTools: <code v-if="plan.reach.translation.allowedTools.length">{{ plan.reach.translation.allowedTools.join(', ') }}</code><span v-else class="text-zinc-500">nenhuma</span>
        </p>
        <div class="rounded-lg border border-zinc-800 px-2 py-1.5 text-xs" data-test="skills">
          <p class="text-zinc-300">
            resources.skills proposto ({{ plan.reach.skills.proposed.length }}):
            <code v-if="plan.reach.skills.proposed.length">{{ plan.reach.skills.proposed.join(', ') }}</code><span v-else class="text-zinc-500">nenhuma</span>
          </p>
          <p class="text-zinc-500">{{ plan.reach.skills.note }}.</p>
          <p v-if="plan.reach.skills.notReleased.length" class="text-amber-200">Citadas e não liberadas (fora da lista): {{ plan.reach.skills.notReleased.join(', ') }}</p>
          <p v-if="plan.reach.skills.pending.length" class="text-zinc-500">Fora do lote e do catálogo (pendentes): {{ plan.reach.skills.pending.join(', ') }}</p>
        </div>
        <ul v-if="plan.reach.notes.some((note) => note.level !== 'info')" class="text-xs text-amber-200">
          <li v-for="note in plan.reach.notes.filter((one) => one.level !== 'info')" :key="note.code">{{ note.text }}</li>
        </ul>
      </template>
    </section>

    <section v-if="plan.mcps.length" class="flex flex-col gap-0.5 text-xs" data-test="mcps">
      <h3 class="font-medium text-zinc-500">MCPs que o agente usa (cadastro à parte)</h3>
      <p v-for="mcp in plan.mcps" :key="mcp.name" :class="mcp.exists ? 'text-zinc-300' : 'text-amber-200'">
        <code>{{ mcp.name }}</code> → <code>{{ mcp.id }}</code> — {{ mcp.exists ? 'existe no gateway' : 'não existe no gateway: as regras dele ficam ❌ até o cadastro' }}
      </p>
    </section>

    <details v-if="plan.released.length" class="text-xs text-zinc-400" data-test="released">
      <summary class="cursor-pointer">Skills liberadas pela permissão e fora do lote ({{ plan.released.length }}) — liberar não é usar</summary>
      <p class="mt-1 flex flex-wrap gap-x-3">
        <code v-for="skill in plan.released" :key="skill.key">{{ skill.id }}</code>
      </p>
    </details>

    <details v-if="exclusions.length" class="text-xs" data-test="excluded">
      <summary class="cursor-pointer text-zinc-400">Fica de fora ({{ plan.excluded.length }})</summary>
      <div v-for="group in exclusions" :key="group.reason" class="mt-1.5">
        <p class="font-medium" :class="group.reason === 'broken' ? 'text-rose-300' : group.reason === 'untranslatable' ? 'text-amber-200' : 'text-zinc-400'">{{ EXCLUSION_LABEL[group.reason] }} ({{ group.entries.length }})</p>
        <ul class="flex flex-col gap-0.5 text-zinc-400">
          <li v-for="entry in group.entries" :key="`${entry.from}|${entry.path ?? entry.code}|${entry.item ?? ''}`" class="break-all">
            <code class="text-zinc-500">{{ entry.from }}</code> {{ entry.text }}
          </li>
        </ul>
      </div>
    </details>
  </section>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex min-w-0 flex-col gap-1.5 text-xs font-medium text-zinc-400;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
