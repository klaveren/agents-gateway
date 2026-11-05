import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'

/**
 * Um menu que abre por cima (o da conta, o do sistema): fecha ao clicar fora, no Esc e ao navegar.
 * `root` é o elemento que contém o botão e o menu — clicar dentro dele não fecha.
 */
export function usePopover(): { open: Ref<boolean>; root: Ref<HTMLElement | undefined> } {
  const route = useRoute()
  const open = ref(false)
  const root = ref<HTMLElement>()

  const onDocument = (event: MouseEvent) => {
    if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') open.value = false
  }
  onMounted(() => {
    document.addEventListener('mousedown', onDocument)
    document.addEventListener('keydown', onKey)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('mousedown', onDocument)
    document.removeEventListener('keydown', onKey)
  })
  watch(
    () => route.fullPath,
    () => (open.value = false),
  )
  return { open, root }
}

/**
 * ⚖️ O menu que abre da BARRA DO CELULAR ocupa a largura da tela (`fixed inset-x-2`), logo acima da barra: preso ao
 * botão, ele saía da tela pelo lado. Devolve a distância do fundo da tela até o topo do botão, medida ao abrir.
 */
export function useAboveBar(open: Ref<boolean>, root: Ref<HTMLElement | undefined>): Ref<number | undefined> {
  const above = ref<number>()
  watch(open, (isOpen) => {
    const rect = root.value?.getBoundingClientRect()
    if (isOpen && rect) above.value = window.innerHeight - rect.top + 8
  })
  return above
}
