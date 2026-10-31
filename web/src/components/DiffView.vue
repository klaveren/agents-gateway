<script setup lang="ts">
import type { IDiffHunk, IDiffLine } from '@/lib/catalogHistory'

/**
 * O DIFF DE LINHAS de uma revisão: os trechos que mudaram, com as linhas de contexto. ⚖️ A linha que entrou leva `+` e
 * a que saiu leva `−`, além da cor: quem não distingue verde de vermelho lê pelo símbolo.
 */
defineProps<{ hunks: IDiffHunk[] }>()

const SYMBOL: Record<IDiffLine['op'], string> = { add: '+', remove: '−', equal: ' ' }
const LABEL: Record<IDiffLine['op'], string> = { add: 'adicionada', remove: 'removida', equal: 'sem mudança' }
</script>

<template>
  <div class="scroll-thin overflow-x-auto rounded-xl border border-zinc-800 font-mono text-[12px] leading-relaxed" data-test="diff">
    <section v-for="(hunk, index) in hunks" :key="index" class="border-b border-zinc-800 last:border-b-0">
      <p class="bg-zinc-900 px-3 py-1 text-[11px] text-sky-300">@@ −{{ hunk.oldStart }},{{ hunk.oldLines }} +{{ hunk.newStart }},{{ hunk.newLines }} @@</p>
      <div
        v-for="(line, position) in hunk.lines"
        :key="position"
        class="flex min-w-max"
        :class="line.op === 'add' ? 'bg-emerald-500/10 text-emerald-200' : line.op === 'remove' ? 'bg-rose-500/10 text-rose-200' : 'text-zinc-400'"
        :data-op="line.op"
      >
        <span class="w-10 shrink-0 px-1 text-right text-zinc-600 select-none">{{ line.oldLine ?? '' }}</span>
        <span class="w-10 shrink-0 px-1 text-right text-zinc-600 select-none">{{ line.newLine ?? '' }}</span>
        <span class="w-5 shrink-0 text-center font-semibold select-none" :title="LABEL[line.op]" :aria-label="LABEL[line.op]">{{ SYMBOL[line.op] }}</span>
        <span class="pr-3 whitespace-pre">{{ line.text }}</span>
        <span v-if="line.noNewline" class="pl-2 text-[11px] text-zinc-500 italic">(sem quebra de linha no fim)</span>
      </div>
    </section>
  </div>
</template>
