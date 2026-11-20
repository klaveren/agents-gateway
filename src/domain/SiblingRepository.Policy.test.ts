import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IPermissionRule } from './Permission.Policy'
import { siblingDir, siblingPattern, siblingReadAllowed } from './SiblingRepository.Policy'

const rule = (category: IPermissionRule['category'], pattern: string, decision: IPermissionRule['decision'] = 'allow'): IPermissionRule => ({ category, pattern, decision })
const project = '/w/p'
const root = '/w/p/repositories/A'

describe('SiblingRepository.Policy', () => {
  it('nomeia o irmão só por nome literal, relativo ao projeto ou absoluto dentro dele', () => {
    assert.strictEqual(siblingDir('repositories/B/**', project, root), '/w/p/repositories/B')
    assert.strictEqual(siblingDir('./repositories/B/src/x.ts', project, root), '/w/p/repositories/B')
    assert.strictEqual(siblingDir('/w/p/repositories/B/**', project, root), '/w/p/repositories/B')
    assert.strictEqual(siblingPattern('repositories/B/**', project, root), '/w/p/repositories/B/**')
    for (const pattern of [
      'repositories/*/**',
      'repositories/**',
      'repositories/B',
      'repositories/B*/**',
      'repositories/{B,C}/**',
      'repositories/_worktrees/**',
      'repositories/A/**',
      'repositories/A/_worktrees/x/**',
      'repositories/B/../A/**',
      'repositories/../B/x',
      '/w/q/repositories/B/**',
      '/w/p/other/B/**',
      '**/B/**',
      'B/**',
    ])
      assert.strictEqual(siblingDir(pattern, project, root), undefined, pattern)
    // Raiz = projeto: nada é irmão (a conversa já vê `repositories/*`).
    assert.strictEqual(siblingDir('repositories/B/**', project, project), undefined)
  })

  it('só uma liberação de LEITURA que nomeia o irmão abre o arquivo; negar vence', () => {
    const file = '/w/p/repositories/B/src/a.ts'
    const ctx = (layers: Parameters<typeof siblingReadAllowed>[1]['layers']) => ({ projectRoot: project, root, layers })
    assert.ok(siblingReadAllowed(file, ctx({ agent: [rule('read', 'repositories/B/**')] })))
    assert.ok(siblingReadAllowed(file, ctx({ project: [rule('read', '/w/p/repositories/B/src/*.ts')] })))
    assert.ok(!siblingReadAllowed(file, ctx({})))
    assert.ok(!siblingReadAllowed(file, ctx({ agent: [rule('write', 'repositories/B/**')] })))
    assert.ok(!siblingReadAllowed(file, ctx({ agent: [rule('read', 'repositories/*/**')] })))
    assert.ok(!siblingReadAllowed(file, ctx({ agent: [rule('read', 'repositories/C/**')] })))
    assert.ok(!siblingReadAllowed(file, ctx({ agent: [rule('read', 'repositories/B/**'), rule('read', 'repositories/B/src/**', 'deny')] })))
    assert.ok(!siblingReadAllowed(file, ctx({ agent: [rule('read', 'repositories/B/**')], project: [rule('read', '**/*.ts', 'deny')] })))
    assert.ok(!siblingReadAllowed('/w/p/repositories/B/.env', ctx({ agent: [rule('read', 'repositories/B/**')] })))
    assert.ok(!siblingReadAllowed(file, ctx({ machine: true, agent: [rule('read', 'repositories/B/**')] })))
    assert.ok(!siblingReadAllowed('/w/q/repositories/B/a.ts', ctx({ agent: [rule('read', 'repositories/B/**')] })))
  })
})
