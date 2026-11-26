import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api, apiBlob } from '@/lib/api'
import type { IDeliveredFile } from '@/lib/fileViewer'
import ConversationFiles from './ConversationFiles.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn(), apiBlob: vi.fn() }))
// O Monaco e o pdf.js não rodam no jsdom: no lugar, o que a tela entrega a eles.
const shown: Array<{ value: string; language: string; readOnly?: boolean }> = []
vi.mock('@/lib/monaco', () => {
  let options: { readOnly?: boolean } = {}
  return {
    monaco: {
      editor: {
        create: (_host: HTMLElement, given: { readOnly?: boolean }) => {
          options = given
          return {
            setModel: (model: { value: string; language: string }) => shown.push({ ...model, readOnly: options.readOnly }),
            dispose: () => undefined,
            getContainerDomNode: () => _host,
          }
        },
        createModel: (value: string, language: string) => ({ value, language, dispose: () => undefined }),
      },
    },
  }
})
vi.mock('./PdfViewer.vue', () => ({ __esModule: true, default: { props: ['data'], render: () => h('div', { 'data-test': 'pdf-stub' }) } }))

const file = (id: string, name: string, mime: string, size = 10): IDeliveredFile => ({ id, conversationId: 'gw_1', name, mime, size, turn: 1, createdAt: '2026-11-24T12:00:00Z' })
const FILES = [
  file('f_img', 'grafico.svg', 'image/svg+xml'),
  file('f_pdf', 'relatorio.pdf', 'application/pdf'),
  file('f_json', 'dados.json', 'application/json'),
  file('f_html', 'pagina.html', 'text/html'),
  file('f_zip', 'pacote.zip', 'application/zip'),
]
const BODY: Record<string, string> = { f_img: '<svg/>', f_pdf: '%PDF-1.7', f_json: '{"a":1}', f_html: '<h1>oi</h1><script>alert(1)</script>' }

let app: App | undefined
const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(selected?: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const counts: number[] = []
  app = createApp({ render: () => h(ConversationFiles, { conversationId: 'gw_1', selected, onCount: (n: number) => counts.push(n) }) })
  app.mount(host)
  await flush()
  return { host, counts }
}

beforeEach(() => {
  shown.length = 0
  vi.mocked(api).mockImplementation(async () => FILES as never)
  vi.mocked(apiBlob).mockImplementation(async (path: string) => new Blob([BODY[path.split('/').at(-2)!] ?? ''], { type: 'application/octet-stream' }))
  URL.createObjectURL = vi.fn(() => 'blob:fake')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
  vi.mocked(apiBlob).mockReset()
})

describe('ConversationFiles — a lista e o visualizador', () => {
  it('lista os arquivos com nome, tipo, tamanho e turno, e conta', async () => {
    const { host, counts } = await mount()
    const rows = host.querySelectorAll('[data-test="conversation-files-list"] li')
    expect(rows).toHaveLength(5)
    expect(rows[0]!.textContent).toContain('grafico.svg')
    expect(rows[0]!.textContent).toContain('SVG')
    expect(rows[0]!.textContent).toContain('10 B')
    expect(rows[0]!.textContent).toContain('turno 2')
    expect(counts).toEqual([5])
    expect(vi.mocked(api)).toHaveBeenCalledWith('/conversations/gw_1/files')
  })

  it('o arquivo escolhido (do chip) abre selecionado, buscando pela rota de visualização', async () => {
    const { host } = await mount('f_img')
    expect(host.querySelector('[data-test="conversation-file-viewer"]')!.getAttribute('data-viewer')).toBe('image')
    expect(vi.mocked(apiBlob)).toHaveBeenCalledWith('/conversations/gw_1/files/f_img/view', expect.anything())
    const img = host.querySelector<HTMLImageElement>('[data-test="image-viewer"]')!
    expect(img.getAttribute('src')).toBe('blob:fake')
    // O SVG vira blob com o tipo de imagem: no `<img>`, não roda script.
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob
    expect(blob.type).toBe('image/svg+xml')
  })

  it('PDF vai para o pdf.js; JSON vai para o Monaco somente leitura, com a linguagem', async () => {
    const { host } = await mount('f_pdf')
    expect(host.querySelector('[data-test="pdf-stub"]')).not.toBeNull()

    host.querySelector<HTMLElement>('[data-test="conversation-file-f_json"]')!.click()
    await flush()
    expect(host.querySelector('[data-test="conversation-file-viewer"]')!.getAttribute('data-viewer')).toBe('code')
    expect(shown.at(-1)).toMatchObject({ value: '{"a":1}', language: 'json', readOnly: true })
  })

  it('⛔ HTML abre como código; a prévia só no clique, num iframe com sandbox vazio via srcdoc', async () => {
    const { host } = await mount('f_html')
    expect(host.querySelector('iframe')).toBeNull()
    expect(shown.at(-1)).toMatchObject({ language: 'html', readOnly: true })

    host.querySelector<HTMLButtonElement>('[data-test="html-preview-toggle"]')!.click()
    await flush()
    const frame = host.querySelector<HTMLIFrameElement>('[data-test="html-preview"]')!
    expect(frame.hasAttribute('sandbox')).toBe(true)
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toBe(BODY.f_html)
    expect(frame.hasAttribute('src')).toBe(false)
  })

  it('o que não abre na tela só baixa, sem buscar o conteúdo', async () => {
    const { host } = await mount('f_zip')
    const only = host.querySelector('[data-test="download-only"]')!
    expect(only.querySelector('a')!.getAttribute('href')).toBe('/v1/conversations/gw_1/files/f_zip')
    expect(only.querySelector('a')!.getAttribute('download')).toBe('pacote.zip')
    expect(vi.mocked(apiBlob)).not.toHaveBeenCalled()
  })
})
