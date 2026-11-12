import { computed, ref } from 'vue'

/**
 * ⚖️ TROCAR DE SERVIDOR é do app do Mac: a mesma janela carrega a tela de outro gateway, com o login dele — nada é
 * sincronizado e nada passa pelo gateway daqui. A tela só fala com a ponte nativa (`gatewayServers`, ver
 * `installers/macos/App.swift`); no navegador a ponte não existe e nada disto aparece.
 * ⛔ O app guarda só o nome e o endereço (nunca senha nem token), e só a tela deste Mac cadastra, remove e vê endereço:
 * a de outro servidor recebe os nomes e troca pelo id.
 */
export interface IServer {
  id: string
  name: string
  /** Só na tela deste Mac. */
  url?: string
  /** O gateway que o app sobe ("Este Mac"): fixo, o primeiro da lista. */
  local?: boolean
}

export interface IServerList {
  /** O servidor que está na janela. */
  current: string
  /** A tela pode cadastrar e remover (é a deste Mac). */
  manage: boolean
  servers: IServer[]
}

interface IBridge {
  postMessage(message: Record<string, unknown>): Promise<unknown>
}

function bridge(): IBridge | undefined {
  return (globalThis as { webkit?: { messageHandlers?: { gatewayServers?: IBridge } } }).webkit?.messageHandlers?.gatewayServers
}

function parse(reply: unknown): IServerList | undefined {
  const value = reply as Partial<IServerList> | undefined
  if (!value || typeof value.current !== 'string' || !Array.isArray(value.servers)) return undefined
  const servers = value.servers.filter((server): server is IServer => typeof server?.id === 'string' && typeof server?.name === 'string')
  return { current: value.current, manage: value.manage === true, servers }
}

const list = ref<IServerList>()
let reading: Promise<void> | undefined

/** A lista do app; `undefined` fora dele (navegador) ou antes da primeira leitura. */
export const serverList = computed(() => list.value)

/** O pedido à ponte: toda resposta é a lista como ficou. A recusa do app (endereço inválido, nome repetido) vem como erro, com o motivo. */
async function ask(message: Record<string, unknown>): Promise<void> {
  const native = bridge()
  if (!native) return
  const next = parse(await native.postMessage(message))
  if (next) list.value = next
}

/** Lê a lista uma vez (os dois menus pedem ao montar); a ponte que falha deixa a tela como no navegador. */
export function loadServers(): Promise<void> {
  return (reading ??= ask({ op: 'list' }).catch(() => undefined))
}

/** A janela passa a mostrar o início desse servidor: esta tela sai. */
export function switchServer(id: string): Promise<void> {
  return ask({ op: 'switch', id })
}

export function addServer(name: string, url: string): Promise<void> {
  return ask({ op: 'add', name, url })
}

export function removeServer(id: string): Promise<void> {
  return ask({ op: 'remove', id })
}

/** O motivo que o app deu ao recusar (a ponte rejeita com um `Error`). */
export function bridgeReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Só para os testes: volta ao estado de antes da primeira leitura. */
export function forgetServers(): void {
  list.value = undefined
  reading = undefined
}
