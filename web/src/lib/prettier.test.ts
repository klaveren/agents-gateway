import { describe, expect, it } from 'vitest'
import { formatText, parseConfig, parserFor } from './prettier'

describe('prettier — formatar no editor, no navegador', () => {
  it('escolhe o parser pela extensão (e o package.json como o Prettier faz)', () => {
    expect(parserFor('src/a.ts')).toBe('typescript')
    expect(parserFor('web/App.vue')).toBe('vue')
    expect(parserFor('package.json')).toBe('json-stringify')
    expect(parserFor('docs/x.md')).toBe('markdown')
    expect(parserFor('script.py')).toBeUndefined()
  })

  it('formata com a config do repositório (JSON, YAML ou package.json)', async () => {
    const json = await parseConfig({ name: '.prettierrc', content: '{ "semi": false, "singleQuote": true }' })
    expect(await formatText('a.ts', 'const a = "x";\n', json)).toBe("const a = 'x'\n")
    const yaml = await parseConfig({ name: '.prettierrc.yaml', content: 'semi: false\nsingleQuote: true\n' })
    expect(await formatText('a.js', 'let b = "y";', yaml)).toBe("let b = 'y'\n")
    const fromPackage = await parseConfig({ name: 'package.json', content: '{ "name": "x", "prettier": { "tabWidth": 4 } }' })
    expect(await formatText('a.json', '{"a":{"b":1}}', fromPackage)).toBe('{ "a": { "b": 1 } }\n')
  })

  it('ignora plugins e overrides vindos do repositório (plugin é código)', async () => {
    const config = await parseConfig({ name: '.prettierrc', content: '{ "semi": false, "plugins": ["prettier-plugin-malicioso"] }' })
    expect(await formatText('a.ts', 'const a = 1;', config)).toBe('const a = 1\n')
  })

  it('formata Vue e CSS', async () => {
    expect(await formatText('C.vue', '<template><div   class="a">x</div></template>\n', {})).toBe('<template><div class="a">x</div></template>\n')
    expect(await formatText('a.css', 'a{color:red}', {})).toBe('a {\n  color: red;\n}\n')
  })
})
