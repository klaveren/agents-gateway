import { ICoreProtocol } from '@domain/models/Protocol.Model'

/** O protocolo do core para construir uma SKILL. ⚠️ Mudou o texto, sobe a versão. */
export const SKILL_PROTOCOL: ICoreProtocol = {
  kind: 'skill',
  version: '1.1.1',
  title: 'Protocolo de construção de skill',
  body: `# Protocolo de construção de skill

Uma skill é um MODO DE FAZER algo. O agente vê só o id e a descrição dela no prompt e a carrega inteira (com use_resource) quando o assunto aparece. Ela só serve se ele souber QUANDO carregá-la e, depois de carregada, exatamente O QUE FAZER.

## Princípios
1. **A skill é o como, nunca o porquê.** Regra, padrão, conceito e decisão moram em specs e ADRs. A skill não os reescreve: ANEXA os documentos de que depende (docIds) — eles vão junto com ela. Regra copiada para dentro da skill é uma segunda verdade que diverge no primeiro toque.
2. **A descrição é o gatilho.** É a única coisa que o agente lê antes de decidir carregar. Uma frase concreta: o que a skill faz e quando usar ("Revisa um pull request contra os padrões de API do projeto"). Nada de "skill útil para várias coisas".
3. **O id diz o trabalho.** Minúsculas e hífens, 2 a 48 caracteres. Nunca o nome de quem usa: o agente que executa pode mudar, e o nome mentiria.
4. **Uma responsabilidade.** Se o pedido tem dois trabalhos que se usam em momentos diferentes, são duas skills.
5. **Nenhum segredo no corpo.** Chave, senha, token e URL com credencial não entram — o corpo é lido por todo agente que a usa e fica gravado nas conversas. Diga o NOME da variável ou da credencial que o ambiente fornece, nunca o valor.
6. **Dado é sagrado.** Se a skill altera ou apaga dado persistente (banco, arquivo, fila, storage), o corpo manda fazer o backup ou a cópia ANTES do passo destrutivo, e diz como conferir que ele existe.
7. **Skill de contrato.** Quando a skill aplica um padrão (de API, de dado, de arquitetura), o primeiro passo exige os documentos anexados: se algum não estiver acessível, o agente RECUSA e diz qual falta — nunca inventa o padrão. O modelo resolve o problema dentro do contrato, não o contrato.

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
- **Várias ações** (criar, alterar, usar, validar): o corpo abre com um roteiro (ação → seção) e cada ação tem a sua seção. Uma ação que sozinha é grande vira outra skill.
- **Script:** um passo que roda um script do repositório leva o cartão — comando, argumentos, pré-requisitos, saída esperada e o que fazer na falha.

## Escopo
- Global vale em todos os projetos; a do projeto, só nele. Na dúvida, do projeto.
- Documento anexado tem de ser global ou do mesmo projeto da skill.
- Documento grande vai por referência (docRefs): a skill carregada lista id, título e tamanho, e o agente o lê com read_doc só quando o passo pedir.
- O agente só usa a skill depois que alguém a libera na guia Recursos dele.`,
}
