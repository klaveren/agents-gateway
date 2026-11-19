import assert from 'node:assert'
import { describe, it } from 'node:test'
import { conversationModelFilter, memberAllows, memberList, memberModelsIssues, modelKey, modelListIssues, parseModelKey, projectAllows } from './ModelAccess.Policy'

describe('ModelAccess.Policy', () => {
  it('a chave é provider/modelo; o modelo pode ter barra, o provider não', () => {
    assert.strictEqual(modelKey('openrouter', 'meta/llama'), 'openrouter/meta/llama')
    assert.deepStrictEqual(parseModelKey('openrouter/meta/llama'), { provider: 'openrouter', model: 'meta/llama' })
    assert.strictEqual(parseModelKey('sem-barra'), undefined)
    assert.strictEqual(parseModelKey('/modelo'), undefined)
    assert.strictEqual(parseModelKey('provider/'), undefined)
  })

  it('⚖️ sem lista, tudo o que vem de cima: projeto e pessoa', () => {
    assert.strictEqual(projectAllows(undefined, 'claude', 'opus'), true)
    assert.strictEqual(memberAllows({}, { userId: 'ana', role: 'member' }, 'claude', 'opus'), true)
  })

  it('🔐 o gateway restringe o projeto; o projeto restringe o papel; a lista da pessoa vence a do papel', () => {
    const models = { allowed: ['claude/opus', 'claude/haiku', 'codex/sol'], byRole: { member: ['claude/haiku'] }, byUser: { bia: ['codex/sol'] } }
    assert.strictEqual(projectAllows(models, 'claude', 'sonnet'), false)
    assert.strictEqual(memberAllows(models, { userId: 'ana', role: 'admin' }, 'claude', 'opus'), true, 'admin sem lista: tudo do projeto')
    assert.strictEqual(memberAllows(models, { userId: 'ana', role: 'member' }, 'claude', 'opus'), false)
    assert.strictEqual(memberAllows(models, { userId: 'ana', role: 'member' }, 'claude', 'haiku'), true)
    assert.deepStrictEqual(memberList(models, { userId: 'bia', role: 'member' }), ['codex/sol'])
    assert.strictEqual(memberAllows(models, { userId: 'bia', role: 'member' }, 'claude', 'haiku'), false)
    // Sem pessoa (agendamento, hook): só o do projeto.
    assert.strictEqual(memberAllows(models, {}, 'claude', 'opus'), true)
  })

  it('⛔ o que o gateway tirou depois deixa de valer para a pessoa, mesmo na lista dela', () => {
    assert.strictEqual(memberAllows({ allowed: ['claude/haiku'], byRole: { member: ['claude/opus'] } }, { role: 'member' }, 'claude', 'opus'), false)
  })

  it('⛔ o admin do projeto só restringe: lista de papel ou pessoa fora do que o projeto recebeu é recusada', () => {
    assert.deepStrictEqual(memberModelsIssues(['claude/haiku'], { byRole: { member: ['claude/haiku'] } }), [])
    assert.deepStrictEqual(memberModelsIssues(['claude/haiku'], { byUser: { ana: ['claude/opus'] } }), [
      { field: 'byUser.ana', message: '"claude/opus" was not released to this project' },
    ])
    assert.deepStrictEqual(memberModelsIssues(undefined, { byRole: { member: ['qualquer/modelo'] } }), [], 'projeto sem lista: qualquer um do gateway')
    assert.deepStrictEqual(modelListIssues('allowed', ['claude/a', 'claude/a', 'ruim']), [
      { field: 'allowed', message: '"claude/a" is repeated' },
      { field: 'allowed', message: '"ruim" is not provider/model' },
    ])
  })
})

describe('🔐 conversationModelFilter — o provider do projeto', () => {
  const ownerOf = (provider: string) => (provider.startsWith('alfa--') ? 'alfa' : undefined)
  it('o provider de um projeto só roda em conversa dele; sem projeto, nenhum', () => {
    assert.strictEqual(conversationModelFilter(undefined, undefined, {}, ownerOf)('alfa--openai', 'gpt'), false)
    assert.strictEqual(conversationModelFilter(undefined, undefined, {}, ownerOf)('claude', 'opus'), true)
    assert.strictEqual(conversationModelFilter('beta', undefined, {}, ownerOf)('alfa--openai', 'gpt'), false)
    assert.strictEqual(conversationModelFilter('alfa', undefined, {}, ownerOf)('alfa--openai', 'gpt'), true)
  })
  it('no projeto dono, a lista do gateway não vale para o provider dele; a do papel, sim', () => {
    const models = { allowed: ['claude/haiku'], byRole: { member: ['claude/haiku'] } }
    const filter = conversationModelFilter('alfa', models, { role: 'member' }, ownerOf)
    assert.strictEqual(filter('alfa--openai', 'gpt'), false, 'fora da lista do papel')
    assert.strictEqual(
      conversationModelFilter('alfa', { allowed: ['claude/haiku'] }, { role: 'member' }, ownerOf)('alfa--openai', 'gpt'),
      true,
      'sem lista do papel: o provider do projeto vale',
    )
    assert.strictEqual(filter('claude', 'opus'), false)
  })
})
