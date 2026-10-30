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
