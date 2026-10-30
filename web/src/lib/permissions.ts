import type { TPermissionCategory } from './types'

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
    hint: 'Em que repositório do projeto (a pasta em repositories/) o agente pode abrir conversa, pelo nome.',
    example: 'logiccus',
  },
]

export const LAYER_LABEL: Readonly<Record<string, string>> = { system: 'sistema', agent: 'agente', project: 'projeto', default: 'sem regra' }
