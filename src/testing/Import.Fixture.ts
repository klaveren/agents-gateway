import { execFileSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Um token com a forma do GitHub: a máscara reconhece pelo formato. Sintético. */
export const FAKE_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`

/** Um repositório SINTÉTICO com cada caso do formato `.agents/` e do opencode. Nada copiado de projeto real. */
export function writeFixture(root: string, outside: string): void {
  const file = (path: string, body: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  file('.agents/README.md', '# Índice\n')
  file('.agents/agents/maya/identity.md', '# Maya\nLeia `.agents/specs/arquitetura.md` e `.agents/specs/inexistente.md`.\n')
  file('.agents/agents/maya/soul.md', 'A alma da Maya.\n')
  file('.agents/agents/maya/maya.yaml', 'model: modelo-a\ncore_dependencies:\n  - .agents/knowledge/filas.md\n')
  file('.agents/agents/maya/bootstrap.md', '<!-- NÃO EDITAR — edite as fontes: .agents/agents/maya/soul.md, .agents/agents/maya/identity.md -->\nconteúdo montado\n')
  file('.agents/agents/maya/triggers/01-delegar.md', '# Delegar\nSegue skills/revisar/SKILL.md\n')
  file('.agents/agents/maya/memory/2026-10-01.md', 'lembrança\n')
  file('.agents/agents/maya/scripts/run.sh', 'echo oi\n')
  file('.agents/agents/maya/scripts/node_modules/lib/index.js', 'module.exports = 1\n')
  file('.agents/agents/maya/avatar.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]))
  file('.agents/skills/revisar/SKILL.md', '---\ndescription: revisa\n---\n# Revisar\nVer [a arquitetura](../../specs/arquitetura.md).\n')
  file('.agents/skills/revisar/triggers/quando.md', 'quando pedirem revisão\n')
  file('.agents/commands/deploy.md', '---\nagent: maya\ndescription: sobe\n---\nFaça o deploy.\n')
  file('.agents/specs/arquitetura.md', '# Arquitetura\n')
  file('.agents/specs/config.md', `# Config\nGITHUB_TOKEN=${FAKE_TOKEN}\n`)
  file('.agents/adr/0001-usar-sqlite.md', '# ADR 1: usar SQLite\n')
  file('.agents/knowledge/filas.md', '# Filas\n')
  file('.agents/rules.md', '# Regras do projeto\n1. Seja direto.\n')
  file('.agents/misc/coisa.txt', 'sem formato\n')
  file('docs/guia.md', '# Guia\n')
  file('node_modules/pkg/README.md', '# pacote\n')
  file(
    'opencode.json',
    [
      '{',
      '  // JSONC: comentário e vírgula sobrando',
      '  "agent": {',
      '    "maya": { "prompt": "{file:./.agents/agents/maya/bootstrap.md}", "model": "modelo-b", "tools": { "bash": true } },',
      '    "revisor": { "prompt": "{file:./prompts/nao-existe.md}" },',
      '    "assistente-lia": { "prompt": "{file:./prompts/lia.md}" },',
      '  },',
      '  "command": { "build": { "template": "rode o build", "description": "build" } },',
      '  "mcp": { "github": { "type": "remote", "url": "https://x.test/mcp" } },',
      '  "permission": { "bash": "ask" },',
      '  "instructions": ["docs/guia.md"],',
      '}',
    ].join('\n'),
  )
  // Nome diferente no opencode: o prompt é um arquivo gerado a partir da pasta da Lia, e isso junta os dois.
  file('.agents/agents/lia/soul.md', 'A alma da Lia.\n')
  file('prompts/lia.md', '# AUTO-GENERATED — DO NOT EDIT. Sources: .agents/agents/lia/soul.md\nprompt montado\n')
  file('.opencode/agent/helper.md', '---\ndescription: ajuda\n---\nAjudo.\n')
  // Link para dentro (deduplica) e link para fora (recusado).
  symlinkSync('../.agents/commands', join(root, '.opencode/command'))
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'segredo.md'), '# de fora\n')
  symlinkSync(outside, join(root, 'link-fora'))
  symlinkSync(join(outside, 'segredo.md'), join(root, 'arquivo-fora.md'))
}

export function gitInit(root: string): void {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
}

/**
 * Um repositório SINTÉTICO do formato do Claude Code e do `AGENTS.md`: `.claude/` com agente, command, skill por link
 * para `.agents/`, settings com permissões, hook, `env` e um segredo falso; `CLAUDE.md` na raiz (que importa) e numa
 * subpasta; `AGENTS.md` na raiz e em `.agents/`; e a saída de benchmark que o admin manda ignorar.
 */
export function writeClaudeFixture(root: string): void {
  const file = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  file('.agents/skills/revisar/SKILL.md', '---\ndescription: revisa\n---\n# Revisar\n')
  file('.agents/skills/revisar/checklist.md', '- testes\n')
  file('.agents/AGENTS.md', '# Contrato do .agents\nLeia `specs/x.md`.\n')
  file('.claude/agents/revisor.md', '---\nname: revisor-codigo\ndescription: revisa PRs\ntools: Read, Grep\nmodel: sonnet\n---\nVocê revisa.\n')
  file('.claude/commands/git/commit.md', '---\ndescription: faz o commit\nallowed-tools: Bash(git commit:*)\n---\nFaça o commit.\n')
  file(
    '.claude/settings.json',
    JSON.stringify(
      {
        permissions: {
          allow: ['Bash(npm run test:*)', 'Read(docs/**/*.md)'],
          deny: [`Bash(curl -H "Authorization: Bearer ${FAKE_TOKEN}" *)`],
        },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/scripts/guarda.sh' }] }] },
        env: { GITHUB_TOKEN: FAKE_TOKEN, API_URL: 'https://api.x.test' },
      },
      null,
      2,
    ),
  )
  symlinkSync('../.agents/skills', join(root, '.claude/skills'))
  file('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['WebFetch(domain:x.test)'] }, enabledMcpjsonServers: ['github'] }, null, 2))
  file('.mcp.json', JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: `Bearer ${FAKE_TOKEN}` } } } }, null, 2))
  file('.claude/scripts/guarda.sh', 'exit 0\n')
  file('.claude/boot.md', '# Boot do projeto\nVeja `.agents/benchmark/results/run-1.md`.\n')
  file('.claude/coisa.txt', 'sem formato\n')
  file('.claude/worktrees/copia/CLAUDE.md', '# cópia\n')
  file('.claude/worktrees/copia/AGENTS.md', '# cópia\n')
  file('CLAUDE.md', '@.claude/boot.md\n@AGENTS.md\n')
  file('pacotes/api/CLAUDE.md', `# Regras da API\nNo código, \`@nao/importa.md\` não é importação.\n${'Use JSON. '.repeat(500)}\n`)
  file('AGENTS.md', '<!--\n# carimbo, não é título\n-->\n# Instruções do projeto\nResponda em português.\n')
  file('.agents/benchmark/results/run-1.md', '# run 1\n')
  file('.agents/benchmark/results/run-2.json', '{}\n')
  file('tmp/results/saida.md', '# saída\n')
}
