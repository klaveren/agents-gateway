import assert from 'node:assert'
import { describe, it } from 'node:test'
import { levelAtLeast, normalizeVoicePreferences, SPEECH_MAX_CHARS, speechText } from './Speech.Model'

describe('speechText', () => {
  it('título e corpo, sem a marcação do Markdown', () => {
    const text = speechText({
      title: 'Deploy pronto',
      body: '# Resumo\n\n- **Tudo** certo\n- veja [o painel](https://x.example/p) e https://x.example/raw\n\n```ts\nconst a = 1\n```\n\nUse `npm test`.',
    })
    assert.strictEqual(text, 'Deploy pronto. Tudo certo veja o painel e. Detalhes na tela.')
  })

  it('sem título, só o corpo; espaços colapsados', () => {
    assert.strictEqual(speechText({ body: '  uma   frase\n  só ' }), 'uma frase só')
  })

  it('texto longo corta numa fronteira de frase e avisa que o resto está na tela', () => {
    const body = Array.from({ length: 200 }, (_, index) => `Frase número ${index}.`).join(' ')
    const text = speechText({ body })
    assert.ok(text.length <= SPEECH_MAX_CHARS)
    assert.ok(text.endsWith('. — o restante está na tela.') || text.endsWith(' — o restante está na tela.'))
    assert.match(text, /Frase número \d+\. — o restante/)
  })

  it('🔊 do padrão O que · Onde · Por quê · Como resolver, só o O que e o Onde (em linhas ou numa linha só)', () => {
    const lines = '**O que:** gerar um token da Meta.\n**Onde:** data table `whatsapp_numbers`.\n**Por quê:** venceu.\n**Como resolver:** 1) abra o Business Manager.'
    const expected = 'Trocar o token. O que: gerar um token da Meta. Onde: data table whatsapp_numbers. Detalhes na tela.'
    assert.strictEqual(speechText({ title: 'Trocar o token', body: lines }), expected)
    assert.strictEqual(speechText({ title: 'Trocar o token', body: lines.replace(/\n/g, ' ') }), expected)
  })

  it('🔊 fora do padrão, o primeiro parágrafo; o título solto não conta', () => {
    assert.strictEqual(speechText({ body: '## Feito\n\nConferi a tabela.\n\n- detalhe 1\n- detalhe 2' }), 'Conferi a tabela. Detalhes na tela.')
    assert.strictEqual(speechText({ body: 'Só isto.' }), 'Só isto.')
  })

  it('🔊 abre com quem mandou e de qual conversa veio', () => {
    assert.strictEqual(
      speechText({ title: 'Preciso do acesso', body: 'Libera o banco?' }, { agent: 'Zeus', conversation: 'Migração do banco.' }),
      'Mensagem de Zeus, da conversa Migração do banco. Preciso do acesso. Libera o banco?',
    )
    assert.strictEqual(speechText({ body: 'oi' }, { agent: 'Zeus' }), 'Mensagem de Zeus. oi')
    assert.strictEqual(speechText({ body: 'oi' }, {}), 'oi')
  })

  it('texto curto não ganha aviso', () => {
    assert.ok(!speechText({ body: 'oi' }).includes('restante'))
  })
})

describe('preferências de voz', () => {
  it('padrões e níveis', () => {
    assert.deepStrictEqual(normalizeVoicePreferences(undefined), { enabled: false, rate: 1, minLevel: 'info' })
    assert.deepStrictEqual(normalizeVoicePreferences({ enabled: true, voice: ' Cherry ', rate: 9, minLevel: 'urgent' }), {
      enabled: true,
      voice: 'Cherry',
      rate: 2,
      minLevel: 'urgent',
    })
    assert.strictEqual(normalizeVoicePreferences({ minLevel: 'x' }).minLevel, 'info')
    assert.ok(levelAtLeast('urgent', 'attention'))
    assert.ok(levelAtLeast('info', 'info'))
    assert.ok(!levelAtLeast('info', 'attention'))
  })
})
