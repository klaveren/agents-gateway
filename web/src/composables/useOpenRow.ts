import { ref } from 'vue'

/**
 * A linha da lista com as ações reveladas (deslizar para a esquerda). Uma só por vez: abrir outra fecha a anterior.
 *
 * ⚖️ Estado de módulo, e não de componente: as linhas não se conhecem, e a lista inteira (inbox e arquivadas) compartilha.
 */
export const openRowId = ref<string>()
