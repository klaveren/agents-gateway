<script setup lang="ts">
import { computed } from 'vue'
import { choiceKey, parseChoice, type IChoice } from '@/lib/agentChoice'
import type { IAgent, IAgentProvider } from '@/lib/types'

/**
 * Provider e modelo num select só, agrupado por provider ("Claude (assinatura)" › modelos). Com um
 * provider só, os grupos somem e fica a lista de modelos de sempre.
 *
 * ⚠️ A escolha atual pode ter saído do agente (modelo desativado no meio da conversa): ela entra na lista,
 * marcada, para o select não mostrar OUTRO modelo e mentir sobre o que a sessão está usando.
 */
const props = defineProps<{
  agent: Pick<IAgent, 'providers'>
  value?: IChoice
  disabled?: boolean
  /** Por que um provider não pode ser escolhido aqui (ex.: não roda a lane da conversa). `undefined` = pode. */
  blocked?: (provider: IAgentProvider) => string | undefined
  selectClass?: string
}>()
const emit = defineEmits<{ pick: [choice: IChoice, select: HTMLSelectElement] }>()

const groups = computed(() =>
  props.agent.providers.map((provider) => {
    const reason = provider.unavailable?.label ?? props.blocked?.(provider)
    const models = [...provider.models]
    const orphan = props.value?.provider === provider.id && !models.includes(props.value.model) ? props.value.model : undefined
    return { provider, reason, models: orphan ? [orphan, ...models] : models, orphan }
  }),
)
const orphanProvider = computed(() => (props.value && !props.agent.providers.some((provider) => provider.id === props.value!.provider) ? props.value : undefined))
const grouped = computed(() => props.agent.providers.length > 1)
const count = computed(() => groups.value.reduce((total, group) => total + (group.reason ? 0 : group.models.length), 0))

function label(provider: IAgentProvider, model: string, orphan?: string): string {
  if (model === orphan) return `${model} (indisponível)`
  const price = provider.pricing[model]
  return `${model}${price ? ` — $${price.output}/1M saída` : ''}`
}

function change(event: Event) {
  const select = event.target as HTMLSelectElement
  const choice = parseChoice(select.value)
  if (choice) emit('pick', choice, select)
}
</script>

<template>
  <select :value="value ? choiceKey(value) : ''" :disabled="disabled || count < 2" :class="selectClass" @change="change">
    <option v-if="orphanProvider" :value="choiceKey(orphanProvider)" disabled>{{ orphanProvider.provider }} · {{ orphanProvider.model }} (indisponível neste agente)</option>
    <template v-for="group in groups" :key="group.provider.id">
      <optgroup v-if="grouped" :label="group.reason ? `${group.provider.name} — ${group.reason}` : group.provider.name">
        <option v-for="model in group.models" :key="model" :value="choiceKey({ provider: group.provider.id, model })" :disabled="!!group.reason || model === group.orphan">
          {{ label(group.provider, model, group.orphan) }}
        </option>
      </optgroup>
      <template v-else>
        <option v-for="model in group.models" :key="model" :value="choiceKey({ provider: group.provider.id, model })" :disabled="!!group.reason || model === group.orphan">
          {{ label(group.provider, model, group.orphan) }}
        </option>
      </template>
    </template>
  </select>
</template>
