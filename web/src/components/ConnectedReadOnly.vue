<script setup lang="ts">
/**
 * 🔌 A faixa do item de projeto CONECTADO: só leitura aqui; mudar é na origem (um ticket). `layer`: o agente, que
 * aceita os ajustes desta máquina em algumas guias.
 */
defineProps<{ origin: string; layer?: boolean }>()
</script>

<template>
  <p class="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-200" data-test="connected-readonly">
    Projeto conectado a <code class="text-sky-100">{{ origin }}</code>: só leitura aqui. Para mudar, abra um ticket — a mudança é feita na origem e chega pela atualização.
    <template v-if="layer">Modelos, Ferramentas, MCPs, Delegação e Permissões aceitam ajustes desta máquina: o que ela acrescenta, e a ferramenta, o MCP ou a delegação da origem que ela desliga.</template>
  </p>
</template>
