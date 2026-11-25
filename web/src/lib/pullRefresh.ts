import { onBeforeUnmount, onMounted } from 'vue'

/**
 * 🔄 O "puxar para atualizar": quem relê o quê. Cada tela (e cada painel aberto nela) registra a sua releitura enquanto
 * está montada; o gesto chama TODAS juntas — a lista de conversas e a conversa aberta, a conversa e o painel de arquivos.
 * ⚖️ Sem nenhuma registrada, vale o `fallback` (os dados globais, ver `App.vue`). Nunca recarrega a página: o rascunho e
 * a posição ficam.
 */
type TRefresh = () => Promise<unknown> | unknown

const handlers = new Set<TRefresh>()
let fallback: TRefresh | undefined
/** O que vale em qualquer tela, antes das releituras (reconectar o stream caído). */
let always: TRefresh | undefined

export function registerRefresh(handler: TRefresh): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function setRefreshFallback(handler: TRefresh | undefined): void {
  fallback = handler
}

export function setRefreshAlways(handler: TRefresh | undefined): void {
  always = handler
}

/** Registra a releitura da tela enquanto o componente estiver montado. */
export function useRefreshHandler(handler: TRefresh): void {
  let unregister: (() => void) | undefined
  onMounted(() => (unregister = registerRefresh(handler)))
  onBeforeUnmount(() => unregister?.())
}

/** Roda as releituras da tela (ou o `fallback`). Falha de uma não derruba as outras. */
export async function runRefresh(): Promise<void> {
  const list = handlers.size ? [...handlers] : fallback ? [fallback] : []
  if (always) list.unshift(always)
  if (!list.length) {
    // Nada a reler: o último recurso é recarregar a página.
    if (typeof location !== 'undefined') location.reload()
    return
  }
  await Promise.allSettled(list.map(async (handler) => handler()))
}
