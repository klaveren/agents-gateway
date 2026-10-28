import { ICoreProtocol } from '@domain/models/Protocol.Model'

/** O protocolo do core para construir uma SKILL. ⚠️ Mudou o texto, sobe a versão. */
export const SKILL_PROTOCOL: ICoreProtocol = {
  kind: 'skill',
  version: '1.0.0',
  title: 'Protocolo de construção de skill',
  body: `# Protocolo de construção de skill

Uma skill é um MODO DE FAZER algo. O agente vê só o id e a descrição dela no prompt e a carrega inteira (com use_skill) quando o assunto aparece. Ela só serve se ele souber QUANDO carregá-la e, depois de carregada, exatamente O QUE FAZER.

## Princípios
1. **A skill é o como, nunca o porquê.** Regra, padrão, conceito e decisão moram em specs e ADRs. A skill não os reescreve: ANEXA os documentos de que depende (docIds) — eles vão inteiros junto com ela. Regra copiada para dentro da skill é uma segunda verdade que diverge no primeiro toque.
2. **A descrição é o gatilho.** É a única coisa que o agente lê antes de decidir carregar. Uma frase concreta: o que a skill faz e quando usar ("Revisa um pull request contra os padrões de API do projeto"). Nada de "skill útil para várias coisas".
3. **O id diz o trabalho.** Minúsculas e hífens, 2 a 48 caracteres. Nunca o nome de quem usa: o agente que executa pode mudar, e o nome mentiria.
4. **Uma responsabilidade.** Se o pedido tem dois trabalhos que se usam em momentos diferentes, são duas skills.
5. **Nenhum segredo no corpo.** Chave, senha, token e URL com credencial não entram — o corpo é lido por todo agente que a usa e fica gravado nas conversas. Diga o NOME da variável ou da credencial que o ambiente fornece, nunca o valor.
6. **Dado é sagrado.** Se a skill altera ou apaga dado persistente (banco, arquivo, fila, storage), o corpo manda fazer o backup ou a cópia ANTES do passo destrutivo, e diz como conferir que ele existe.

## O corpo
Markdown operacional, sem visão geral nem teoria (essa é a spec anexada). Nesta ordem:

\`\`\`markdown
# <Nome amigável>

**Objetivo:** <uma frase>.

## 1. Entrada e validação
- O que conferir antes de começar (o pedido está completo? o alvo existe?).
- O que perguntar à pessoa quando faltar.

## 2. Execução
- Passos imperativos, na ordem. Cada um diz o que fazer, com que ferramenta e o resultado esperado.
- Onde houver decisão, o critério dela.

## 3. Saída e conferência
- [ ] O que tem de estar verdadeiro para dar como feito.
- [ ] O que relatar à pessoa (inclusive o que falhou).
\`\`\`

- Imperativo e curto. Um passo por linha.
- Cite os documentos anexados pelo título quando um passo depender deles ("siga a spec Padrões de API").
- Exemplos só quando o formato da saída importa.

## Escopo
- Global vale em todos os projetos; a do projeto, só nele. Na dúvida, do projeto.
- Documento anexado tem de ser global ou do mesmo projeto da skill.
- O agente só usa a skill depois que alguém a libera na guia Recursos dele.`,
}
