<script setup lang="ts">
  import { computed, ref, useId } from 'vue'
  import Icon from '@/components/Icon.vue'
  import { normalizeTag } from '@/lib/listFilter'

  /**
   * O campo de TAGS de um item: as escolhidas viram chips que se removem; Enter, vírgula ou sair do campo adiciona a
   * digitada (já no formato do servidor: `normalizeTag`). Backspace com o campo vazio tira a última. As sugestões são as
   * tags que a lista já usa, menos as escolhidas.
   */
  const MAX_TAGS = 20
  const tags = defineModel<string[]>({ default: () => [] })
  const props = defineProps<{ suggestions?: readonly string[]; issues?: readonly string[]; label?: string }>()
  const draft = ref('')
  const listId = useId()
  const offered = computed(() => (props.suggestions ?? []).filter((tag) => !tags.value.includes(tag)))
  const full = computed(() => tags.value.length >= MAX_TAGS)

  /** Põe as tags do texto (separadas por vírgula) no fim, sem repetir e até o teto. */
  function add(text: string) {
    const next = [...tags.value]
    for (const part of text.split(',')) {
      const tag = normalizeTag(part)
      if (tag && !next.includes(tag) && next.length < MAX_TAGS) next.push(tag)
    }
    if (next.length !== tags.value.length) tags.value = next
    draft.value = ''
  }

  const remove = (tag: string) => (tags.value = tags.value.filter((item) => item !== tag))

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter dentro de um formulário salvaria; aqui só confirma a tag.
      event.preventDefault()
      add(draft.value)
    } else if (event.key === 'Backspace' && !draft.value && tags.value.length) {
      tags.value = tags.value.slice(0, -1)
    }
  }

  // Colar "a, b, c" ou ESCOLHER uma sugestão da lista adiciona na hora. Digitar a palavra de uma sugestão, não: quem
  // digita `logiccus` pode estar a caminho de `logiccus-core`.
  function onInput(event: Event) {
    const typed = (event as InputEvent).inputType?.startsWith('insertText') || (event as InputEvent).inputType?.startsWith('delete')
    if (draft.value.includes(',') || (!typed && offered.value.includes(draft.value))) add(draft.value)
  }
</script>

<template>
  <div class="tags-field">
    <span v-if="label">{{ label }}</span>
    <div class="box">
      <span v-for="tag in tags" :key="tag" class="chip on tag-chip">
        {{ tag }}
        <button type="button" class="grid place-items-center text-emerald-200/70 hover:text-rose-300" :aria-label="`Tirar a tag ${tag}`" @click="remove(tag)"><Icon name="x" class="h-3 w-3" /></button>
      </span>
      <input
        v-model="draft"
        :list="listId"
        :disabled="full"
        :placeholder="full ? `Máximo de ${MAX_TAGS} tags` : tags.length ? '' : 'infra, logiccus…'"
        :aria-label="label ?? 'Adicionar tag'"
        maxlength="40"
        autocomplete="off"
        class="min-w-24 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-zinc-600"
        @keydown="onKey"
        @input="onInput"
        @blur="add(draft)"
      />
      <datalist :id="listId">
        <option v-for="tag in offered" :key="tag" :value="tag" />
      </datalist>
    </div>
    <small class="hint">Enter ou vírgula adiciona. Minúsculas, sem acento, com hífen (até {{ MAX_TAGS }}). Servem para filtrar a lista.</small>
    <small v-for="message in issues" :key="message" class="error">{{ message }}</small>
  </div>
</template>

<style scoped>
  @reference '../style.css';

  .tags-field {
    @apply flex min-w-0 flex-col gap-1.5 text-sm font-medium text-zinc-300;
  }
  .box {
    @apply flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1 font-normal text-zinc-100 focus-within:border-emerald-500/60;
  }
  .tag-chip {
    @apply min-h-6 gap-1 py-0.5 pr-1.5 pl-2.5;
  }
  .hint {
    @apply text-xs font-normal text-zinc-500;
  }
  .error {
    @apply text-xs font-normal text-rose-300;
  }
</style>
