import { afterEach, describe, expect, it, vi } from 'vitest'
import { addServer, forgetServers, loadServers, serverList, switchServer } from './servers'

type TWindow = { webkit?: unknown }
const LIST = {
  current: 'local',
  manage: true,
  servers: [
    { id: 'local', name: 'Este Mac', local: true },
    { id: 's4', name: 'Servidor 4', url: 'https://quatro.exemplo.com' },
  ],
}

function install(postMessage: (message: Record<string, unknown>) => Promise<unknown>) {
  const spy = vi.fn(postMessage)
  ;(globalThis as TWindow).webkit = { messageHandlers: { gatewayServers: { postMessage: spy } } }
  return spy
}

afterEach(() => {
  delete (globalThis as TWindow).webkit
  forgetServers()
})

describe('servers — a ponte do app do Mac', () => {
  it('no navegador (sem a ponte) não há lista, e trocar não faz nada', async () => {
    await loadServers()
    await switchServer('s4')
    expect(serverList.value).toBeUndefined()
  })

  it('lê a lista uma vez só, mesmo pedida pelos dois menus', async () => {
    const post = install(async () => LIST)
    await Promise.all([loadServers(), loadServers()])
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith({ op: 'list' })
    expect(serverList.value?.servers.map((server) => server.name)).toEqual(['Este Mac', 'Servidor 4'])
  })

  it('a recusa do app chega como erro, com o motivo, e a lista fica como estava', async () => {
    install(async (message) => {
      if (message.op === 'add') throw new Error('Esse endereço já está cadastrado.')
      return LIST
    })
    await loadServers()
    await expect(addServer('Outro', 'https://quatro.exemplo.com')).rejects.toThrow('Esse endereço já está cadastrado.')
    expect(serverList.value?.servers).toHaveLength(2)
  })

  it('a ponte que falha na leitura deixa a tela como no navegador', async () => {
    install(async () => {
      throw new Error('recusado')
    })
    await loadServers()
    expect(serverList.value).toBeUndefined()
  })

  it('resposta fora do formato não vira lista', async () => {
    install(async () => ({ servers: 'x' }))
    await loadServers()
    expect(serverList.value).toBeUndefined()
  })
})
