<script setup lang="ts">
  import { onBeforeUnmount } from 'vue'
  import { LIST_WIDTH, useListWidth } from '@/composables/useListWidth'

  /**
   * A alça na borda direita da coluna da lista (telas largas): arrastar muda a largura; duplo clique volta ao padrão;
   * as setas do teclado ajustam de 20 em 20.
   */
  const { width, set, reset } = useListWidth()
  let start: { x: number; width: number; moved: boolean } | undefined

  /** ⛔ Soltar o mouse em cima de uma linha da lista não pode abrir a conversa: o clique que fecha o arraste é engolido. */
  function swallowClick(event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
  }

  function move(event: PointerEvent) {
    if (!start) return
    if (Math.abs(event.clientX - start.x) > 2) start.moved = true
    set(start.width + event.clientX - start.x)
  }
  function stop() {
    if (start?.moved) {
      window.addEventListener('click', swallowClick, { capture: true, once: true })
      // Sem clique depois (soltou fora da janela): a trava sai sozinha.
      setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 0)
    }
    start = undefined
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  function begin(event: PointerEvent) {
    start = { x: event.clientX, width: width.value, moved: false }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  function key(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      set(width.value + (event.key === 'ArrowRight' ? 20 : -20))
    }
  }
  onBeforeUnmount(stop)
</script>

<template>
  <div
    role="separator"
    aria-orientation="vertical"
    aria-label="Largura da lista"
    :aria-valuenow="width"
    :aria-valuemin="LIST_WIDTH.min"
    :aria-valuemax="LIST_WIDTH.max"
    tabindex="0"
    title="Arraste para mudar a largura · duplo clique volta ao padrão"
    class="absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-emerald-500/60 focus-visible:outline-none focus-visible:after:bg-emerald-500/60 lg:block"
    data-test="list-resizer"
    @pointerdown.prevent="begin"
    @dblclick="reset"
    @keydown="key"
  />
</template>
