<script setup lang="ts">
  import { computed, onMounted } from 'vue'
  import { BUILD_KINDS, builderAgentId, type TBuildKind } from '@/lib/builder'
  import { fixPattern, PERMISSION_SECTIONS, patternWarning } from '@/lib/permissions'
  import type { IPermissionRule, TPermissionCategory } from '@/lib/types'
  import { useAgentsStore } from '@/stores/agents'

  /**
   * O editor de regras de permissão, por categoria. ⚖️ A ordem não importa: dentro da mesma lista, Negar vence Permitir.
   * Mora dentro de formulários: nada aqui submete com Enter.
   */
  const rules = defineModel<IPermissionRule[]>({ required: true })
  /** `only`: uma categoria só (a guia escolhida na tela de Permissões). */
  const props = defineProps<{ readonly?: boolean; only?: TPermissionCategory }>()

  const byCategory = computed(() =>
    PERMISSION_SECTIONS.filter((section) => !props.only || section.category === props.only).map((section) => ({ ...section, rules: rules.value.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.category === section.category) })),
  )

  /**
   * ⚖️ Na DELEGAÇÃO o padrão é um agente: escolhido numa lista (os agentes, os construtores do sistema e os curingas de
   * sempre), não digitado. O padrão gravado que não está na lista aparece como está, para não sumir.
   */
  const agents = useAgentsStore()
  onMounted(() => void agents.ensure().catch(() => undefined))
  const delegateGroups = computed(() => [
    {
      label: 'Curingas',
      options: [
        { value: '*', label: 'Todos os agentes (*)' },
        { value: 'builder-*', label: 'Todos os construtores do sistema (builder-*)' },
      ],
    },
    { label: 'Agentes', options: agents.list.map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.id})` })) },
    {
      label: 'Do sistema',
      options: (Object.keys(BUILD_KINDS) as TBuildKind[]).map((kind) => ({ value: builderAgentId(kind), label: `${BUILD_KINDS[kind].builder} (${builderAgentId(kind)})` })),
    },
  ])
  const knownDelegate = (pattern: string) => !pattern || delegateGroups.value.some((group) => group.options.some((option) => option.value === pattern))

  function add(category: TPermissionCategory) {
    rules.value = [...rules.value, { category, pattern: '', decision: 'allow' }]
  }
  function remove(index: number) {
    rules.value = rules.value.filter((_, at) => at !== index)
  }
  function update(index: number, change: Partial<IPermissionRule>) {
    rules.value = rules.value.map((rule, at) => (at === index ? { ...rule, ...change } : rule))
  }
</script>

<template>
  <div class="flex flex-col gap-3">
    <section v-for="section in byCategory" :key="section.category" class="rounded-xl border border-zinc-800">
      <header class="flex items-baseline gap-2 border-b border-zinc-800 px-3 py-2">
        <h3 class="text-sm font-medium text-zinc-200">{{ section.label }}</h3>
        <span class="text-xs text-zinc-500">{{ section.rules.length || 'nenhuma regra' }}</span>
        <button v-if="!readonly" type="button" class="btn btn-sm btn-ghost ml-auto" @click="add(section.category)">+ Regra</button>
      </header>
      <p class="px-3 pt-2 text-xs text-zinc-500">{{ section.hint }}</p>
      <ul class="flex flex-col gap-1.5 p-3">
        <li v-for="{ rule, index } in section.rules" :key="index" class="flex flex-wrap items-center gap-2">
          <select
            v-if="section.category === 'delegate'"
            :value="rule.pattern"
            :disabled="readonly"
            aria-label="Agente"
            class="input min-w-0 flex-1 text-[13px]"
            @change="update(index, { pattern: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>Escolha o agente…</option>
            <option v-if="!knownDelegate(rule.pattern)" :value="rule.pattern">{{ rule.pattern }}</option>
            <optgroup v-for="group in delegateGroups" :key="group.label" :label="group.label">
              <option v-for="option in group.options" :key="option.value" :value="option.value">{{ option.label }}</option>
            </optgroup>
          </select>
          <input
            v-else
            :value="rule.pattern"
            :readonly="readonly"
            :placeholder="section.example"
            class="input min-w-0 flex-1 font-mono text-[13px]"
            @input="update(index, { pattern: ($event.target as HTMLInputElement).value })"
            @keydown.enter.prevent
          />
          <div class="flex gap-1">
            <button type="button" class="chip" :class="{ on: rule.decision === 'allow' }" :disabled="readonly" @click="update(index, { decision: 'allow' })">Permitir</button>
            <button type="button" class="chip" :class="{ 'on-deny': rule.decision === 'deny' }" :disabled="readonly" @click="update(index, { decision: 'deny' })">Negar</button>
          </div>
          <input
            :value="rule.note ?? ''"
            :readonly="readonly"
            placeholder="nota (opcional)"
            class="input w-40 text-xs"
            @input="update(index, { note: ($event.target as HTMLInputElement).value || undefined })"
            @keydown.enter.prevent
          />
          <button v-if="!readonly" type="button" class="btn btn-sm btn-danger" title="Remover a regra" @click="remove(index)">Remover</button>
          <p v-if="patternWarning(rule)" class="flex w-full flex-wrap items-center gap-2 text-xs text-amber-300">
            ⚠ {{ patternWarning(rule) }}
            <button v-if="!readonly" type="button" class="btn btn-sm btn-ghost" @click="update(index, { pattern: fixPattern(rule.pattern) })">
              Trocar por {{ fixPattern(rule.pattern) }}
            </button>
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
  @reference '../style.css';

  .input {
    @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
  }
  .chip.on-deny {
    @apply border-rose-500/60 bg-rose-500/15 text-rose-200;
  }
</style>
