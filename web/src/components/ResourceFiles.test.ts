import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { api } from '@/lib/api'
import { fileIssue, toBase64, type IResourceFile } from '@/lib/resourceFiles'
import ResourceFiles from './ResourceFiles.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const flush = async () => {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
}

const SAVED: IResourceFile[] = [{ path: 'scripts/saldo.sh', sha256: 'a'.repeat(64), bytes: 11 }]

async function mount(save = vi.fn(async () => undefined)) {
  const host = document.createElement('div')
  document.body.append(host)
  createApp({ render: () => h(ResourceFiles, { files: SAVED, where: 'global/skills/banco', save }) }).mount(host)
  await flush()
  return { host, save }
}

describe('lib/resourceFiles', () => {
  it('o caminho segue a regra do servidor; o base64 aguenta arquivo grande', () => {
    expect([fileIssue('scripts/a.sh', []), fileIssue('../a', []), fileIssue('', [])].map(Boolean)).toEqual([false, true, true])
    expect(fileIssue('a.sh', [{ path: 'a.sh', sha256: '', bytes: 0 }])).toContain('Já existe')
    expect(fileIssue('scripts', [{ path: 'scripts/a.sh', sha256: '', bytes: 0 }])).toContain('pasta')
    expect(toBase64(new TextEncoder().encode('oi'))).toBe('b2k=')
    expect(toBase64(new Uint8Array(200_000)).length).toBe(266_668)
  })
})

describe('ResourceFiles', () => {
  beforeEach(() => vi.mocked(api).mockReset())

  it('novo arquivo: envia o texto, entra no rascunho e "Salvar arquivos" grava a lista inteira', async () => {
    vi.mocked(api).mockResolvedValue({ sha256: 'b'.repeat(64), bytes: 9 })
    const { host, save } = await mount()
    expect(host.querySelector('[data-test="files-save"]')!.hasAttribute('disabled')).toBe(true)
    ;(host.querySelector('[data-test="files-new"]') as HTMLButtonElement).click()
    await flush()
    const path = host.querySelector<HTMLInputElement>('[data-test="editor-path"]')!
    path.value = 'scripts/extrato.sh'
    path.dispatchEvent(new Event('input'))
    const text = host.querySelector<HTMLTextAreaElement>('[data-test="editor-text"]')!
    text.value = 'echo oi\n'
    text.dispatchEvent(new Event('input'))
    host.querySelector('[data-test="file-editor"]')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(api).toHaveBeenCalledWith('/files', { method: 'POST', body: { content: btoa('echo oi\n') } })
    expect(host.querySelectorAll('[data-test="file-row"]')).toHaveLength(2)
    ;(host.querySelector('[data-test="files-save"]') as HTMLButtonElement).click()
    await flush()
    expect(save).toHaveBeenCalledWith([...SAVED, { path: 'scripts/extrato.sh', sha256: 'b'.repeat(64), bytes: 9 }])
  })

  it('o erro do servidor (segredo, binário) aparece; remover tira do rascunho', async () => {
    const { ApiError } = await import('@/lib/api')
    vi.mocked(api).mockRejectedValueOnce(new ApiError(422, 'validation_error', 'the file has a secret', [{ field: 'content', message: 'looks like a secret (token)' }]))
    const { host } = await mount()
    ;(host.querySelector('[data-test="files-new"]') as HTMLButtonElement).click()
    await flush()
    host.querySelector('[data-test="file-editor"]')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(host.querySelector('[data-test="files-error"]')!.textContent).toContain('looks like a secret')
    ;(host.querySelector('[data-test="file-remove"]') as HTMLButtonElement).click()
    await flush()
    expect(host.querySelectorAll('[data-test="file-row"]')).toHaveLength(0)
  })
})
