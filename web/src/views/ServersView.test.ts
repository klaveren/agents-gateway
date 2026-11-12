import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { forgetServers, type IServer } from '@/lib/servers'
import ServersView from './ServersView.vue'

type TWindow = { webkit?: unknown }

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

/** O app de mentira: guarda a lista e recusa como o de verdade (a recusa chega como erro). */
function install(manage = true, refuse?: string) {
  const servers: IServer[] = [
    { id: 'local', name: 'Este Mac', local: true },
    { id: 's4', name: 'Servidor 4', url: 'https://quatro.exemplo.com' },
  ]
  const post = vi.fn(async (message: Record<string, unknown>) => {
    if (message.op === 'add') {
      if (refuse) throw new Error(refuse)
      servers.push({ id: 'novo', name: String(message.name), url: String(message.url) })
    }
    if (message.op === 'remove')
      servers.splice(
        servers.findIndex((server) => server.id === message.id),
        1,
      )
    return { current: manage ? 'local' : 's4', manage, servers: manage ? [...servers] : servers.map(({ id, name, local }) => ({ id, name, local })) }
  })
  ;(globalThis as TWindow).webkit = { messageHandlers: { gatewayServers: { postMessage: post } } }
  return post
}

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(ServersView) })
  app.mount(host)
  await flush()
  return host
}

const test = (name: string) => document.querySelector<HTMLElement>(`[data-test="${name}"]`)
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-test="server-row"]')]
/** A linha como a pessoa lê: o nome, a etiqueta, o endereço e os botões. */
const read = (row: HTMLElement) => [...row.querySelectorAll('span, div.text-xs, button')].map((item) => item.textContent!.trim())
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)

async function type(name: string, value: string) {
  const input = test(name) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  delete (globalThis as TWindow).webkit
  forgetServers()
})

describe('ServersView — os servidores do app do Mac', () => {
  it('no navegador a tela só explica: não há lista nem cadastro', async () => {
    await mount()
    expect(test('servers-no-app')!.textContent).toContain('app do Mac')
    expect(rows()).toHaveLength(0)
    expect(test('servers-form')).toBeNull()
  })

  it('lista Este Mac (fixo, sem Remover) e os cadastrados com o endereço; o que está na janela não tem Abrir', async () => {
    const post = install()
    await mount()
    expect(rows().map(read)).toEqual([
      ['Este Mac', 'aberto', 'O gateway que o app sobe neste Mac.'],
      ['Servidor 4', 'https://quatro.exemplo.com', 'Abrir', 'Remover'],
    ])

    button(rows()[1], 'Abrir')!.click()
    await flush()
    expect(post).toHaveBeenLastCalledWith({ op: 'switch', id: 's4' })
  })

  it('Adicionar grava na hora e limpa o formulário', async () => {
    const post = install()
    await mount()
    await type('servers-name', 'Homologação')
    await type('servers-url', '10.0.0.7:3210')
    test('servers-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(post).toHaveBeenLastCalledWith({ op: 'add', name: 'Homologação', url: '10.0.0.7:3210' })
    expect(rows()).toHaveLength(3)
    expect((test('servers-name') as HTMLInputElement).value).toBe('')
    expect(test('servers-add-error')).toBeNull()
  })

  it('a recusa do app aparece com o motivo dele, e o que foi digitado fica', async () => {
    install(true, 'Já existe um servidor com esse nome.')
    await mount()
    await type('servers-name', 'Servidor 4')
    await type('servers-url', 'https://outro.exemplo.com')
    test('servers-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(test('servers-add-error')!.textContent).toBe('Já existe um servidor com esse nome.')
    expect((test('servers-name') as HTMLInputElement).value).toBe('Servidor 4')
    expect(rows()).toHaveLength(2)
  })

  it('Remover pede confirmação na tela e só então tira da lista', async () => {
    const post = install()
    await mount()
    button(rows()[1], 'Remover')!.click()
    await flush()
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Remover “Servidor 4”?')
    expect(post).toHaveBeenCalledTimes(1)

    button(dialog, 'Remover')!.click()
    await flush()
    expect(post).toHaveBeenLastCalledWith({ op: 'remove', id: 's4' })
    expect(rows()).toHaveLength(1)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('na tela de outro servidor a lista é só leitura: troca, mas não cadastra nem remove', async () => {
    install(false)
    await mount()
    expect(rows().map(read)).toEqual([
      ['Este Mac', 'O gateway que o app sobe neste Mac.', 'Abrir'],
      ['Servidor 4', 'aberto'],
    ])
    expect(test('servers-form')).toBeNull()
    expect(test('servers-read-only')!.textContent).toContain('Este Mac')
  })
})
