import assert from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { cliToolResultDirs, forgetCliToolResults, trackCliToolResults } from './Cli.ToolResults'

describe('a saída grande que o CLI do Claude guarda (tool-results)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gw-cli-results-')))
  const cwd = join(root, 'projects', 'alfa.site')
  const place = (cliSessionId: string) => ({ configDir: join(root, 'claude-cli'), cwd, cliSessionId })
  const dirOf = (cliSessionId: string) => join(root, 'claude-cli', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), cliSessionId, 'tool-results')
  mkdirSync(dirOf('aaaa-1111'), { recursive: true })
  mkdirSync(dirOf('bbbb-2222'), { recursive: true })
  beforeEach(() => forgetCliToolResults())
  after(() => rmSync(root, { recursive: true, force: true }))

  it('a pasta é a da conversa anotada, e só depois que o CLI a cria', () => {
    trackCliToolResults('gw_1', place('cccc-3333'))
    assert.deepStrictEqual(cliToolResultDirs('gw_1'), [])
    trackCliToolResults('gw_1', place('aaaa-1111'))
    assert.deepStrictEqual(cliToolResultDirs('gw_1'), [dirOf('aaaa-1111')])
  })

  it('⛔ conversa sem anotação, ou sem id, não ganha pasta nenhuma', () => {
    trackCliToolResults('gw_1', place('aaaa-1111'))
    assert.deepStrictEqual(cliToolResultDirs('gw_2'), [])
    assert.deepStrictEqual(cliToolResultDirs(undefined), [])
  })

  it('⛔ o id do CLI nunca sobe de pasta', () => {
    mkdirSync(join(root, 'claude-cli', 'projects', 'tool-results'), { recursive: true })
    trackCliToolResults('gw_1', place('..'))
    assert.deepStrictEqual(cliToolResultDirs('gw_1'), [])
  })

  it('a conversa que recomeça no CLI passa a ler a pasta nova', () => {
    trackCliToolResults('gw_1', place('aaaa-1111'))
    trackCliToolResults('gw_1', place('bbbb-2222'))
    assert.deepStrictEqual(cliToolResultDirs('gw_1'), [dirOf('bbbb-2222')])
  })
})
