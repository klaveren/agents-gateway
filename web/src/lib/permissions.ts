import type { IPermissionRule, TPermissionCategory } from './types'

/** As categorias na ordem da tela, com o que o padrão quer dizer em cada uma. */
export const PERMISSION_SECTIONS: ReadonlyArray<{ category: TPermissionCategory; label: string; hint: string; example: string }> = [
  { category: 'terminal', label: 'Terminal', hint: 'Comandos, por palavras: `*` sozinho vale qualquer sequência de argumentos.', example: 'git *' },
  {
    category: 'read',
    label: 'Ler arquivos',
    hint: 'Caminhos dentro do projeto, em glob; sem barra vale o nome em qualquer pasta. Fora do projeto: caminho absoluto.',
    example: 'apps/**',
  },
  { category: 'write', label: 'Escrever arquivos', hint: 'Os mesmos padrões de caminho, para criar e editar.', example: 'apps/**' },
  { category: 'network', label: 'Rede', hint: 'Destinos, com subdomínio e porta opcionais. Vale na etapa do terminal cercado.', example: '*.logiccus.com' },
  { category: 'mcp', label: 'MCP', hint: 'Ferramentas como servidor/ferramenta.', example: 'logiccus/ticket_*' },
  { category: 'skill', label: 'Skills', hint: 'Pelo id da skill.', example: 'akm-*' },
  { category: 'delegate', label: 'Delegação', hint: 'Pelo id do agente a quem pode pedir ajuda.', example: 'agent-*' },
  { category: 'account', label: 'Contas', hint: 'Pelo id da conta do projeto (Projeto → Contas) que o terminal recebe.', example: 'github-*' },
  {
    category: 'repository',
    label: 'Repositórios',
    hint: 'Os repositórios do projeto já são liberados: use Negar para tirar o agente de um deles, pelo nome.',
    example: 'logiccus',
  },
]

/**
 * ⛔ `**` numa regra de terminal: o padrão é por palavras, e só o `*` sozinho vale qualquer sequência de argumentos.
 * `**` casa UMA palavra (o `ls`, não o `cat arquivo`). O servidor recusa salvar; a tela avisa antes e oferece a troca.
 */
const LONE_STARS = /(^|\s)\*{2,}(?=\s|$)/g

export function patternWarning(rule: IPermissionRule): string | undefined {
  if (rule.category !== 'terminal' || !new RegExp(LONE_STARS.source).test(rule.pattern)) return undefined
  return 'No terminal, ** casa uma palavra só (o comando sem argumentos). Para qualquer comando ou argumento, use *.'
}

/** O padrão com cada `**` solto trocado por `*`. */
export function fixPattern(pattern: string): string {
  return pattern.replace(LONE_STARS, '$1*')
}

export const LAYER_LABEL: Readonly<Record<string, string>> = { system: 'sistema', agent: 'agente', project: 'projeto', default: 'sem regra' }
