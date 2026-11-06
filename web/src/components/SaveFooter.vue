<script setup lang="ts">
  /**
   * O RODAPÉ DE SALVAR de uma tela: um botão só, que diz o que grava ("Salvar projeto"), preso embaixo e à vista por mais
   * longa que seja a tela. ⚖️ O padrão do app: um salvar por tela, sempre aqui; o que grava na hora usa verbo próprio
   * ("Adicionar", "Gravar valor"), nunca "Salvar". O slot põe ações ao lado (Cancelar, Duplicar); `#end`, à direita (Apagar).
   * `pending`: há mudança não salva (o aviso aparece ao lado do botão).
   */
  withDefaults(defineProps<{ label: string; busy?: boolean; disabled?: boolean; pending?: boolean; submit?: boolean }>(), { busy: false, disabled: false, pending: false, submit: false })
  defineEmits<{ save: [] }>()
</script>

<template>
  <div class="save-footer flex flex-wrap items-center gap-2" data-test="save-footer">
    <button :type="submit ? 'submit' : 'button'" class="btn btn-primary" :disabled="busy || disabled" @click="submit ? undefined : $emit('save')">
      {{ busy ? 'Salvando…' : label }}
    </button>
    <slot />
    <span v-if="pending" class="text-xs text-amber-300">Mudança não salva</span>
    <div class="ml-auto flex items-center gap-2"><slot name="end" /></div>
  </div>
</template>

<style scoped>
  @reference '../style.css';

  /* Preso ao pé da área que rola (o `py-5` dela fica por baixo), com a largura dela inteira. */
  .save-footer {
    @apply sticky -bottom-5 z-10 -mx-4 mt-2 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur;
  }
</style>
