import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import Composer from './Composer.vue'

let app: App | undefined

async function mount(key: { value: string | undefined }, sent: string[] = [], suggestion?: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const draftKey = ref(key.value)
  app = createApp({
    render: () =>
      h(Composer, {
        sending: false,
        draftKey: draftKey.value,
        suggestion,
        onSend: (text: string, _files: unknown, settle: (ok: boolean) => void) => (sent.push(text), settle(true)),
      }),
  })
  app.mount(host)
  await nextTick()
  return { host, area: () => host.querySelector('textarea')!, draftKey }
}

const type = async (area: HTMLTextAreaElement, value: string) => {
  area.value = value
  area.dispatchEvent(new Event('input'))
  await nextTick()
}

beforeEach(() => {
  localStorage.clear()
  // O jsdom não tem `matchMedia` (o Composer pergunta se a tela é estreita).
  window.matchMedia = (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as never
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

describe('Composer — o rascunho de cada conversa', () => {
  it('o que se digita volta ao reabrir a conversa; cada conversa tem o seu; enviar limpa', async () => {
    const first = await mount({ value: 'A' })
    await type(first.area(), 'meio pensamento')
    app!.unmount()
    document.body.innerHTML = ''

    const again = await mount({ value: 'A' })
    expect(again.area().value).toBe('meio pensamento')

    again.draftKey.value = 'B'
    await nextTick()
    expect(again.area().value).toBe('')
    await type(again.area(), 'da outra')
    again.draftKey.value = 'A'
    await nextTick()
    expect(again.area().value).toBe('meio pensamento')

    again.area().form!.dispatchEvent(new Event('submit', { cancelable: true }))
    await nextTick()
    expect(again.area().value).toBe('')
    expect(localStorage.getItem('gw-draft:A')).toBeNull()
    expect(localStorage.getItem('gw-draft:B')).toBe('da outra')
  })

  it('sem chave, nada fica guardado', async () => {
    const { area } = await mount({ value: undefined })
    await type(area(), 'solto')
    expect(localStorage.length).toBe(0)
  })
})

describe('Composer — a sugestão de próximo passo', () => {
  it('com a caixa vazia, aparece no lugar do texto de exemplo; Tab a põe na caixa; digitou, ela some', async () => {
    const { area } = await mount({ value: 'C' }, [], 'Pode seguir com o varejonline')
    expect(area().placeholder).toContain('Pode seguir com o varejonline')
    expect(area().placeholder).toContain('Tab')
    area().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    await nextTick()
    expect(area().value).toBe('Pode seguir com o varejonline')
    await type(area(), 'outra coisa')
    expect(area().placeholder).not.toContain('Pode seguir')
  })

  it('no celular vira um botão acima da caixa', async () => {
    window.matchMedia = (() => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined })) as never
    const { host, area } = await mount({ value: 'D' }, [], 'Rode os testes')
    const button = host.querySelector<HTMLButtonElement>('[data-test="composer-suggestion"]')!
    expect(button.textContent).toContain('Rode os testes')
    button.click()
    await nextTick()
    expect(area().value).toBe('Rode os testes')
  })
})
