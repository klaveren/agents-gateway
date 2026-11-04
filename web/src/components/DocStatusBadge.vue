<script setup lang="ts">
import { computed } from 'vue'
import { DOC_STATUS_BADGE, DOC_STATUS_LABEL, docStatusOf } from '@/lib/docStatus'
import type { TDocStatus } from '@/lib/types'

/** O selo de status de uma linha de lista: só aparece quando não é aceita. */
const props = defineProps<{ status?: TDocStatus }>()
const status = computed(() => docStatusOf({ status: props.status }))
</script>

<template>
  <span v-if="DOC_STATUS_BADGE[status]" class="inline-block shrink-0 rounded-full px-1.5 py-0.5 text-[10px]" :class="DOC_STATUS_BADGE[status]" data-test="doc-status">{{ DOC_STATUS_LABEL[status] }}</span>
</template>
