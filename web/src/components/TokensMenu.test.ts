import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import TokensMenu from './TokensMenu.vue'

let app: App | undefined
afterEach(() => {
  app?.unmount()
  document.body.innerHTML = ''
})

async function mount(props: Record<string, unknown>) {
  const host = document.createElement('div')
  document.body.append(host)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] })
  app = createApp({ render: () => h(TokensMenu, props as never) })
  app.use(router)
  app.mount(host)
  await router.isReady()
  return host
}

describe('TokensMenu — o consumo da conversa num ícone', () => {
  it('fechado é só o ícone; aberto mostra o detalhe, o total exato, o custo e o contexto', async () => {
    const host = await mount({
      usage: { inputTokens: 1200, outputTokens: 3400, cacheReadTokens: 163_000_000, totalTokens: 163_604_600 },
      costUsd: 52.65,
      turns: 12,
      context: { label: '170k / 200k', percent: 83 },
    })
    const button = host.querySelector<HTMLButtonElement>('[data-test="tokens-menu"]')!
    expect(host.textContent?.trim()).toBe('')
    expect(button.title).toBe('163.6M tokens · $52.65')

    button.click()
    await nextTick()
    const text = host.textContent ?? ''
    expect(text).toContain('Entrada nova')
    expect(text).toContain('163.000.000')
    expect(text).toContain('163.604.600')
    expect(text).toContain('$52.65')
    expect(text).toContain('170k / 200k · 83%')
    expect(text).not.toContain('Raciocínio')
  })

  it('sem custo (quem não administra), só os tokens', async () => {
    const host = await mount({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
    host.querySelector<HTMLButtonElement>('[data-test="tokens-menu"]')!.click()
    await nextTick()
    expect(host.textContent).not.toContain('$')
  })
})
