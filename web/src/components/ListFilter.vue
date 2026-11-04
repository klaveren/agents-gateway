<script setup lang="ts">
  import { computed } from 'vue'
  import Icon from '@/components/Icon.vue'
  import { tagCounts } from '@/lib/listFilter'

  /**
   * A BUSCA e as TAGS no topo de uma lista (o mesmo campo das conversas). Quem filtra é a lista (`filterList`); aqui só
   * o que a pessoa escolhe. As tags aparecem quando algum item tem; clicar na escolhida a solta.
   */
  const query = defineModel<string>('query', { required: true })
  const tag = defineModel<string>('tag', { default: '' })
  const props = defineProps<{ placeholder: string; items?: readonly object[] }>()
  const tags = computed(() => tagCounts(props.items ?? []))
</script>

<template>
  <div class="px-3 pb-2">
    <label class="flex items-center gap-2 rounded-full bg-zinc-800/80 px-3 py-2 text-sm focus-within:ring-1 focus-within:ring-emerald-500/60">
      <Icon name="search" class="h-4 w-4 text-zinc-500" />
      <input v-model="query" type="search" :placeholder="placeholder" :aria-label="placeholder" class="w-full bg-transparent outline-none placeholder:text-zinc-500" />
    </label>
    <div v-if="tags.length || tag" class="scroll-thin mt-2 flex gap-1.5 overflow-x-auto">
      <button v-for="item in tags" :key="item.tag" type="button" class="chip shrink-0" :class="{ on: tag === item.tag }" @click="tag = tag === item.tag ? '' : item.tag">
        {{ item.tag }} <span class="text-zinc-500">{{ item.count }}</span>
      </button>
    </div>
  </div>
</template>
