import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { useResource } from '@/composables/useResource'
import { keyedResource } from './resource'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => ((resolve = ok), (reject = fail)))
  return { promise, resolve, reject }
}

describe('keyedResource — o dado do servidor guardado por chave', () => {
  it('ensure busca uma vez; quem pede no meio espera a mesma busca; depois vem da store', async () => {
    const fetcher = vi.fn(async (key: string) => [key])
    const resource = keyedResource(fetcher)
    const [a, b] = await Promise.all([resource.ensure('alfa'), resource.ensure('alfa')])
    expect([a, b, fetcher.mock.calls.length]).toEqual([['alfa'], ['alfa'], 1])
    await resource.ensure('alfa')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect([resource.get('alfa'), resource.has('alfa'), resource.has('beta')]).toEqual([['alfa'], true, false])
  })

  it('refresh busca de novo; a resposta velha não sobrescreve a nova', async () => {
    const calls: Array<ReturnType<typeof deferred<string>>> = []
    const resource = keyedResource(() => {
      calls.push(deferred<string>())
      return calls.at(-1)!.promise
    })
    const first = resource.ensure('k')
    const second = resource.refresh('k')
    calls[1].resolve('nova')
    await second
    calls[0].resolve('velha')
    await first
    expect(resource.get('k')).toBe('nova')
  })

  it('set e update gravam sem buscar; drop e clear esquecem; o erro fica na chave até dar certo', async () => {
    let fail = true
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error('caiu')
      return [1, 2]
    })
    const resource = keyedResource(fetcher)
    await expect(resource.ensure('k')).rejects.toThrow('caiu')
    expect([resource.has('k'), (resource.error('k') as Error).message]).toEqual([false, 'caiu'])
    fail = false
    await resource.ensure('k')
    expect([resource.get('k'), resource.error('k')]).toEqual([[1, 2], undefined])
    resource.update('k', (list) => [...list, 3])
    resource.set('outra', [9])
    expect([resource.get('k'), resource.get('outra'), resource.keys()]).toEqual([[1, 2, 3], [9], ['k', 'outra']])
    resource.update('nada', () => [0])
    expect(resource.has('nada')).toBe(false)
    resource.drop('k')
    expect(resource.has('k')).toBe(false)
    resource.clear()
    expect(resource.keys()).toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('staleMs: depois do prazo o ensure busca de novo; refreshLoaded relê só o que já foi lido', async () => {
    let clock = 0
    const fetcher = vi.fn(async (key: string) => `${key}@${clock}`)
    const resource = keyedResource(fetcher, { staleMs: 1000, now: () => clock })
    await resource.ensure('a')
    clock = 500
    expect(await resource.ensure('a')).toBe('a@0')
    clock = 1500
    expect(await resource.ensure('a')).toBe('a@1500')
    clock = 2000
    await resource.refreshLoaded()
    expect([resource.get('a'), fetcher.mock.calls.length]).toEqual(['a@2000', 3])
  })
})

describe('useResource — a tela lê da store pela chave', () => {
  it('garante a leitura quando a chave muda; duas telas, uma busca; o dado é o mesmo, reativo', async () => {
    const fetcher = vi.fn(async (key: string) => ({ key }))
    const resource = keyedResource(fetcher)
    const key = ref<string | undefined>(undefined)
    const seen: Array<Array<string | undefined>> = []
    const Screen = defineComponent({
      setup() {
        const { data } = useResource(resource, key)
        return () => h('span', data.value?.key ?? '-')
      },
    })
    const host = document.createElement('div')
    createApp({ render: () => [h(Screen), h(Screen)] }).mount(host)
    const flush = async () => {
      for (let i = 0; i < 3; i++) await nextTick()
      seen.push([...host.querySelectorAll('span')].map((one) => one.textContent ?? undefined))
    }
    await flush()
    key.value = 'alfa'
    await flush()
    resource.set('alfa', { key: 'alfa*' })
    await flush()
    expect(seen).toEqual([
      ['-', '-'],
      ['alfa', 'alfa'],
      ['alfa*', 'alfa*'],
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
