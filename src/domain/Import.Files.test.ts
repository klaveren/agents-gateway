import assert from 'node:assert'
import { describe, it } from 'node:test'
import { importFilesOf, isFileSource, textSources } from './Import.Files'
import { IInventoryItem } from './models/ImportInventory.Model'

const source = (path: string, role?: string) => ({ path, aliases: [], bytes: 3, tokens: 1, sha256: 'a'.repeat(64), ...(role ? { role } : {}) })
const item = (key: string, sources: IInventoryItem['sources']): IInventoryItem => ({
  key,
  kind: key.split(':')[0] as IInventoryItem['kind'],
  candidateId: key.split(':')[1],
  detectors: ['agents-dir'],
  sources,
  refs: [],
  unresolved: [],
  notes: [],
})

describe('Import.Files — os arquivos que a importação leva para a pasta do recurso', () => {
  it('skill: os anexos que não são markdown, com o caminho relativo à pasta dela; o markdown segue texto do rascunho', () => {
    const skill = item('skill:banco', [
      source('.agents/skills/banco/SKILL.md', 'skill'),
      source('.agents/skills/banco/scripts/saldo.mjs', 'attachment'),
      source('.agents/skills/banco/referencia.md', 'attachment'),
    ])
    assert.deepStrictEqual(
      importFilesOf(skill, 'skill', []).files.map((file) => [file.source, file.path]),
      [['.agents/skills/banco/scripts/saldo.mjs', 'scripts/saldo.mjs']],
    )
    assert.deepStrictEqual(
      textSources('skill', skill.sources).map((one) => one.path),
      ['.agents/skills/banco/SKILL.md', '.agents/skills/banco/referencia.md'],
    )
    assert.strictEqual(isFileSource('command', source('x.sh', 'attachment')), false)
  })

  it('agente: a pasta scripts/ dele (do item "fora do catálogo"); caminho que a pasta não aceita fica de fora, com o motivo', () => {
    const agent = item('agent:maya', [source('.agents/agents/maya/AGENT.md', 'prompt')])
    const scripts = item('skip:.agents/agents/maya/scripts', [source('.agents/agents/maya/scripts/bank/balance.mjs'), source('.agents/agents/maya/scripts/com espaço.sh')])
    const other = item('skip:.agents/agents/bia/scripts', [source('.agents/agents/bia/scripts/x.sh')])
    const found = importFilesOf(agent, 'agent', [agent, scripts, other])
    assert.deepStrictEqual(
      found.files.map((file) => file.path),
      ['scripts/bank/balance.mjs'],
    )
    assert.deepStrictEqual(
      found.skipped.map((entry) => entry.path),
      ['.agents/agents/maya/scripts/com espaço.sh'],
    )
  })
})
