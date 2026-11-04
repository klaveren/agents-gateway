import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import TagsInput from './TagsInput.vue'

function mount(initial: string[]) {
  const tags = ref(initial)
  const host = document.createElement('div')
  document.body.append(host)
  createApp({ render: () => h(TagsInput, { modelValue: tags.value, 'onUpdate:modelValue': (value: string[]) => (tags.value = value), suggestions: ['infra', 'rede'] }) }).mount(
    host,
  )
  const input = host.querySelector('input') as HTMLInputElement
  const type = async (text: string, key: string) => {
    input.value = text
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }))
    await nextTick()
  }
  return { tags, host, type }
}

describe('TagsInput', () => {
  it('Enter e vírgula adicionam a tag normalizada, sem repetir; Backspace com o campo vazio tira a última', async () => {
    const { tags, type } = mount(['infra'])
    await type('Integração Logiccus', 'Enter')
    expect(tags.value).toEqual(['infra', 'integracao-logiccus'])
    await type('infra', ',')
    expect(tags.value).toEqual(['infra', 'integracao-logiccus'])
    await type('', 'Backspace')
    expect(tags.value).toEqual(['infra'])
  })

  it('mostra as escolhidas como chips que se removem, e só sugere as que faltam', async () => {
    const { tags, host } = mount(['infra'])
    expect(host.querySelectorAll('.tag-chip')).toHaveLength(1)
    expect([...host.querySelectorAll('datalist option')].map((option) => option.getAttribute('value'))).toEqual(['rede'])
    ;(host.querySelector('.tag-chip button') as HTMLButtonElement).click()
    await nextTick()
    expect(tags.value).toEqual([])
  })

  it('o teto é de 20 tags', async () => {
    const { tags, type } = mount(Array.from({ length: 20 }, (_, index) => `t${index}`))
    await type('nova', 'Enter')
    expect(tags.value).toHaveLength(20)
  })
})
