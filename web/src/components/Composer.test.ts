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

describe('anexar sem o clipe', () => {
  const settle = async () => {
    for (let index = 0; index < 10; index++) await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  const chips = (host: HTMLElement) => Array.from(host.querySelectorAll('form span.rounded-full')).map((chip) => chip.textContent?.trim())
  const withData = (type: string, field: 'clipboardData' | 'dataTransfer', files: File[]) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, field, { value: { files, types: files.length ? ['Files'] : ['text/plain'] } })
    return event
  }

  it('colar um print anexa a imagem, com nome próprio no lugar de image.png', async () => {
    const { host, area } = await mount({ value: 'P' })
    const event = withData('paste', 'clipboardData', [new File(['x'], 'image.png', { type: 'image/png' })])
    area().dispatchEvent(event)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(chips(host)).toEqual([expect.stringMatching(/^imagem-\d{6}-1\.png$/)])
  })

  it('colar só texto não mexe nos anexos', async () => {
    const { host, area } = await mount({ value: 'Q' })
    const event = withData('paste', 'clipboardData', [])
    area().dispatchEvent(event)
    await settle()
    expect(event.defaultPrevented).toBe(false)
    expect(chips(host)).toEqual([])
  })

  it('soltar arquivos em cima da caixa anexa todos, com o nome original', async () => {
    const { host } = await mount({ value: 'R' })
    const form = host.querySelector('[data-test="composer"]')!
    const files = [new File(['a'], 'relatorio.pdf', { type: 'application/pdf' }), new File(['b'], 'dados.csv', { type: 'text/csv' })]
    form.dispatchEvent(withData('dragover', 'dataTransfer', files))
    await nextTick()
    expect(form.className).toContain('outline-dashed')
    const drop = withData('drop', 'dataTransfer', files)
    form.dispatchEvent(drop)
    await settle()
    expect(drop.defaultPrevented).toBe(true)
    expect(form.className).not.toContain('outline-dashed')
    expect(chips(host)).toEqual(['relatorio.pdf', 'dados.csv'])
  })
})
