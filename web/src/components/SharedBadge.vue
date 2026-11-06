<script setup lang="ts">
import { computed } from 'vue'
import { scopeLabel } from '@/lib/guidance'
import { useProjectsStore } from '@/stores/projects'

/**
 * O selo de um item que veio de OUTRO projeto (compartilhado, só leitura aqui): "compartilhado por <nome>". O nome vem da
 * lista de projetos; quem não é membro do projeto de origem vê o id.
 */
const props = defineProps<{ from?: string }>()
const projects = useProjectsStore()
const name = computed(() => scopeLabel(props.from, projects.list))
</script>

<template>
  <span v-if="from" class="inline-block max-w-full shrink-0 truncate rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300" data-test="shared-badge" :title="`Compartilhado por ${name}: só leitura aqui`">compartilhado por {{ name }}</span>
</template>
