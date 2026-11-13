import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import RailMenu, { type IRailMenuItem } from './RailMenu.vue'

let app: App | undefined

const ITEMS: IRailMenuItem[] = [
  { to: '/projects', key: 'projects', label: 'Projetos', hint: 'p', icon: 'agents' },
  {
    key: 'logs',
    label: 'Logs',
    hint: 'API, erros e catálogo',
    icon: 'shield',
    children: [
      { to: '/audit', key: 'audit', label: 'API', hint: 'a', icon: 'shield' },
      { to: '/errors', key: 'errors', label: 'Erros', hint: 'e', icon: 'warn' },
    ],
  },
]

async function mount(active?: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(RailMenu, { title: 'Sistema', icon: 'settings', items: ITEMS, placement: 'side', active }) })
  app.use(router).mount(host)
  await nextTick()
  host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click()
  await nextTick()
  return host
}

const links = (host: HTMLElement) => [...host.querySelectorAll('[role="menuitem"]')].map((item) => item.querySelector('span > span')?.textContent?.trim())

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

describe('RailMenu — o agrupador', () => {
  it('fechado mostra só o grupo; clicar abre os filhos', async () => {
    const host = await mount()
    expect(links(host)).toEqual(['Projetos'])
    host.querySelector<HTMLButtonElement>('[data-test="menu-group-logs"]')!.click()
    await nextTick()
    expect(links(host)).toEqual(['Projetos', 'API', 'Erros'])
  })

  it('abre já aberto quando a página atual é um dos filhos (e o botão do menu fica aceso)', async () => {
    const host = await mount('errors')
    expect(links(host)).toEqual(['Projetos', 'API', 'Erros'])
    expect(host.querySelector('button[aria-haspopup="menu"]')!.className).toContain('text-emerald-300')
  })
})
