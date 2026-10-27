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
