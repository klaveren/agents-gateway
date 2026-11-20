import { describe, expect, it } from 'vitest'
import { importPrefix, parseJsonc, resolveFolder, tsconfigAliases } from './editorExtras'

describe('editorExtras — caminhos no import', () => {
  it('reconhece o caminho relativo dentro das aspas do import/require', () => {
    expect(importPrefix(`import x from './`)).toBe('./')
    expect(importPrefix(`import { a } from "../lib/ut`)).toBe('../lib/ut')
    expect(importPrefix(`const y = require('./a/`)).toBe('./a/')
    expect(importPrefix(`await import('./x`)).toBe('./x')
    expect(importPrefix(`import x from 'vue`)).toBeUndefined()
    expect(importPrefix(`const s = './nao-e-import`)).toBeUndefined()
  })

  it('resolve a pasta a partir do arquivo, sem sair da raiz', () => {
    expect(resolveFolder('src/components', './')).toBe('src/components')
    expect(resolveFolder('src/components', '../lib/ut')).toBe('src/lib')
    expect(resolveFolder('src', '../../x')).toBeUndefined()
    expect(resolveFolder('', './src/')).toBe('src')
  })
})

describe('editorExtras — aliases do tsconfig', () => {
  it('lê JSON com comentário e vírgula sobrando', () => {
    expect(parseJsonc('{\n  // comentário\n  "a": "http://x", /* bloco */ "b": [1,],\n}')).toEqual({ a: 'http://x', b: [1] })
  })

  it('junta os paths do tsconfig e do extends, com o baseUrl', async () => {
    const files: Record<string, string> = {
      'apis/bot/tsconfig.json': '{ "extends": "./tsconfig.build.json", "include": ["src/**/*.ts"] }',
      'apis/bot/tsconfig.build.json': '{ "compilerOptions": { "baseUrl": "./src", "paths": { "@domain/*": ["./domain/*"], "@src/*": ["./*"] } } }',
    }
    const aliases = await tsconfigAliases('apis/bot/tsconfig.json', async (path) => files[path])
    expect(aliases).toEqual([
      { prefix: '@domain/', wildcard: true, target: 'apis/bot/src/domain' },
      { prefix: '@src/', wildcard: true, target: 'apis/bot/src' },
    ])
  })
})
