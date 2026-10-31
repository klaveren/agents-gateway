<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { IWideningRef } from '@/lib/catalogHistory'

/**
 * A CONFIRMAÇÃO DE AMPLIAÇÃO: o que a troca abre de acesso, item por item, cada um com a sua caixa. ⛔ O botão só liga
 * com TODAS marcadas — o servidor só aceita o conjunto inteiro (`confirm` igual ao calculado). A lista nova (o servidor
 * recalculou) desmarca tudo: a pessoa confirma o que vê.
 */
const props = defineProps<{ widenings: IWideningRef[]; action: string; busy?: boolean }>()
const emit = defineEmits<{ confirm: [keys: string[]]; cancel: [] }>()

const checked = ref<Set<string>>(new Set())
watch(
  () => props.widenings,
  () => (checked.value = new Set()),
)

const allChecked = computed(() => props.widenings.length > 0 && props.widenings.every((item) => checked.value.has(item.key)))

function toggle(key: string, on: boolean) {
  const next = new Set(checked.value)
  if (on) next.add(key)
  else next.delete(key)
  checked.value = next
}
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3" data-test="widening-confirm">
    <div>
      <p class="text-sm font-medium text-amber-100">Esta troca amplia acesso</p>
      <p class="text-xs text-amber-200/80">Confirme cada item. Sem todos marcados, nada é gravado.</p>
    </div>
    <ul class="flex flex-col gap-1.5">
      <li v-for="item in widenings" :key="item.key">
        <label class="flex items-start gap-2 text-sm text-zinc-100">
          <input
            type="checkbox"
            class="mt-0.5 accent-amber-500"
            :checked="checked.has(item.key)"
            :data-key="item.key"
            @change="toggle(item.key, ($event.target as HTMLInputElement).checked)"
          />
          <span class="min-w-0">
            {{ item.description }}
            <code class="block truncate text-[11px] text-zinc-500" :title="item.key">{{ item.key }}</code>
          </span>
        </label>
      </li>
    </ul>
    <div class="flex gap-2">
      <button type="button" class="btn btn-primary" :disabled="!allChecked || busy" data-test="widening-submit" @click="emit('confirm', widenings.map((item) => item.key))">
        {{ busy ? 'Gravando…' : action }}
      </button>
      <button type="button" class="btn btn-ghost" @click="emit('cancel')">Cancelar</button>
    </div>
  </section>
</template>
