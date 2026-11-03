import assert from 'node:assert'
import { describe, it } from 'node:test'
import { AGENTIC_PLACES, AGENTIC_SCOPE_DEFAULTS, analysedScope, normalizeScope, placeMatcher, scopeIssues, scopeMatcher } from './Import.Scope'

describe('Import.Scope — o ambiente agêntico que o importador olha', () => {
  it('os lugares padrão de cada ferramenta, sem repetir o AGENTS.md (opencode e Codex)', () => {
    assert.deepStrictEqual(AGENTIC_SCOPE_DEFAULTS.find((tool) => tool.id === 'claude')?.places, ['.claude/', 'CLAUDE.md', '.mcp.json'])
    assert.strictEqual(AGENTIC_PLACES.filter((place) => place === 'AGENTS.md').length, 1)
    for (const place of [
      '.agents/',
      '.opencode/',
      'opencode.jsonc',
      '.codex/',
      '.cursorrules',
      '.github/prompts/',
      'GEMINI.md',
      '.windsurfrules',
      '.clinerules',
      '.roo/',
      '.continue/',
      '**/CLAUDE.md',
    ])
      assert.ok(AGENTIC_PLACES.includes(place), place)
  })

  it('pasta, arquivo (ou pasta com o nome) e entrada só nas subpastas', () => {
    assert.ok(placeMatcher('.claude/')('.claude/agents/x.md'))
    assert.ok(!placeMatcher('.claude/')('.claude.md'))
    assert.ok(placeMatcher('CLAUDE.md')('CLAUDE.md'))
    assert.ok(!placeMatcher('CLAUDE.md')('pacotes/CLAUDE.md'), 'o da raiz é só o da raiz')
    assert.ok(placeMatcher('.clinerules')('.clinerules') && placeMatcher('.clinerules')('.clinerules/estilo.md'))
    assert.ok(placeMatcher('**/AGENTS.md')('packages/api/AGENTS.md'))
    assert.ok(!placeMatcher('**/AGENTS.md')('AGENTS.md'), 'na raiz é outro lugar')
    assert.ok(!placeMatcher('**/AGENTS.md')('packages/api/src/x.ts'), 'nunca a subpasta inteira')
    assert.ok(placeMatcher('AGENTS.md')('agents.md'), 'sem diferença de caixa')
  })

  it('o predicado: padrões ligados mais os a mais (semântica do ignorar); o desligado sai', () => {
    const all = scopeMatcher(normalizeScope())
    assert.ok(all('.agents/specs/x.md') && all('./CLAUDE.md'))
    assert.ok(!all('src/app.ts') && !all('packages/framework/nodemon.json'))
    const narrowed = scopeMatcher(normalizeScope({ disabled: ['.agents/'], extra: ['scripts', 'docs/**/*.md'] }))
    assert.ok(!narrowed('.agents/specs/x.md'))
    assert.ok(narrowed('scripts/deploy.sh') && narrowed('tools/scripts/x.sh'), 'sem / casa o nome em qualquer pasta')
    assert.ok(narrowed('docs/a/b.md') && !narrowed('docs/a/b.txt'))
  })

  it('normaliza (ordem dos padrões, sem desconhecido) e recusa o que sai do repositório', () => {
    assert.deepStrictEqual(normalizeScope({ disabled: ['GEMINI.md', '.agents/', 'x/'], extra: [' ./docs/ ', 'docs'] }), { disabled: ['.agents/', 'GEMINI.md'], extra: ['docs'] })
    assert.deepStrictEqual(scopeIssues({ disabled: [], extra: [] }), [])
    assert.deepStrictEqual(
      scopeIssues({ disabled: ['src/'], extra: ['../fora', '/etc'] }).map((issue) => issue.field),
      ['disabled.0', 'extra.0', 'extra.1'],
    )
    assert.deepStrictEqual(
      scopeIssues({}).map((issue) => issue.field),
      ['disabled', 'extra'],
    )
  })

  it('o ambiente de uma análise volta à forma guardada', () => {
    assert.deepStrictEqual(
      analysedScope({
        places: [
          { place: '.agents/', enabled: true },
          { place: '.cursor/', enabled: false },
        ],
        extra: [{ pattern: 'docs' }],
      }),
      { disabled: ['.cursor/'], extra: ['docs'] },
    )
  })
})
