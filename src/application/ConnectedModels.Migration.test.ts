import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IProjectModels } from '@domain/models/Project.Model'
import { IProjectConnection } from '@domain/models/ProjectConnection.Model'
import { ConnectedModelsMigration } from './ConnectedModels.Migration'

/** 🔌 A manutenção da subida: os modelos e grupos que vieram da origem saem uma vez; o que é desta máquina fica. */
describe('ConnectedModelsMigration', () => {
  function build(options: { autoUpdate?: boolean; pending?: boolean; failSync?: boolean } = {}) {
    const connections = new Map<string, IProjectConnection>([
      ['logiccus', { projectId: 'logiccus', autoUpdate: options.autoUpdate ?? true, syncedVersion: 3, latestVersion: options.pending ? 4 : 3 } as IProjectConnection],
      ['novo', { projectId: 'novo', autoUpdate: true, syncedVersion: 1, latestVersion: 1, modelsLocalAt: new Date() } as IProjectConnection],
    ])
    const models = new Map<string, IProjectModels | undefined>([
      [
        'logiccus',
        {
          allowed: ['claude/claude-sonnet-5'],
          modelGroups: [{ id: 'executor-low', name: 'E', steps: [{ provider: 'alibaba', model: 'qwen' }] }],
          defaultModelGroup: 'executor-low',
        },
      ],
      ['novo', { modelGroups: [{ id: 'local', name: 'L', steps: [] }] }],
    ])
    const synced: string[] = []
    const lines: string[] = []
    const migration = new ConnectedModelsMigration({
      connections: {
        list: () => [...connections.values()],
        markModelsLocal: (id) => connections.set(id, { ...connections.get(id)!, modelsLocalAt: new Date() }),
        sync: async (id) => {
          if (options.failSync) throw new Error('a origem não respondeu')
          synced.push(id)
        },
      },
      projects: {
        exists: (id) => models.has(id),
        forgetModelGroups: (id) => {
          const { modelGroups, defaultModelGroup, ...rest } = models.get(id) ?? {}
          const removed = [...(modelGroups ?? []).map((group) => `grupo ${group.id}`), ...(defaultModelGroup ? [`grupo padrão ${defaultModelGroup}`] : [])]
          models.set(id, rest)
          return removed
        },
      },
      log: (line) => lines.push(line),
    })
    return { migration, models, synced, lines, connections }
  }

  it('limpa a conexão de antes, mantém o que é da máquina, ressincroniza e registra; a de depois do fix não é tocada', async () => {
    const { migration, models, synced, lines } = build()
    const { cleaned, synced: done } = migration.run()
    await done
    assert.deepStrictEqual(cleaned, [{ projectId: 'logiccus', removed: ['grupo executor-low', 'grupo padrão executor-low'] }])
    assert.deepStrictEqual(models.get('logiccus'), { allowed: ['claude/claude-sonnet-5'] })
    assert.deepStrictEqual(
      models.get('novo')?.modelGroups?.map((group) => group.id),
      ['local'],
    )
    assert.deepStrictEqual(synced, ['logiccus'])
    assert.match(lines.join('\n'), /logiccus: removido o que veio da origem \(grupo executor-low, grupo padrão executor-low\)/)
  })

  it('⚖️ idempotente: a segunda subida não faz nada (o que se configurou depois fica)', async () => {
    const { migration, models, synced } = build()
    await migration.run().synced
    models.set('logiccus', { modelGroups: [{ id: 'executor-low', name: 'Local', steps: [{ provider: 'claude', model: 'claude-sonnet-5' }] }] })
    const again = migration.run()
    await again.synced
    assert.deepStrictEqual(again.cleaned, [])
    assert.strictEqual(models.get('logiccus')?.modelGroups?.[0].name, 'Local')
    assert.deepStrictEqual(synced, ['logiccus'])
  })

  it('com a atualização automática desligada e versão nova esperando, não sincroniza sozinha; a falha da origem não desfaz a limpeza', async () => {
    const off = build({ autoUpdate: false, pending: true })
    await off.migration.run().synced
    assert.deepStrictEqual(off.synced, [])
    assert.match(off.lines.join('\n'), /próxima atualização/)

    const failing = build({ failSync: true })
    await failing.migration.run().synced
    assert.ok(failing.connections.get('logiccus')?.modelsLocalAt)
    assert.match(failing.lines.join('\n'), /a sincronização falhou/)
  })
})
