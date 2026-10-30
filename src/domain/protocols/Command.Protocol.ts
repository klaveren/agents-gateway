import { ICoreProtocol } from '@domain/models/Protocol.Model'

/** O protocolo do core para construir um COMMAND. ⚠️ Mudou o texto, sobe a versão. */
export const COMMAND_PROTOCOL: ICoreProtocol = {
  kind: 'command',
  version: '1.1.0',
  title: 'Protocolo de construção de command',
  body: `# Protocolo de construção de command

Um command é um PEDIDO PRONTO que a pessoa dispara digitando /nome argumentos na conversa. O gateway troca isso pelo corpo do command (com $ARGUMENTS no lugar do que veio depois do nome), junta os documentos anexados e manda ao agente. A conversa guarda o que a pessoa digitou.

## Princípios
1. **Só existe se houver julgamento dentro.** Decisão, ordem de prioridade, critério, conferência. Um command que só manda "rode tal coisa" é uma segunda porta para o mesmo trabalho e alguém a mantém para sempre: isso é instrução numa skill ou numa spec, não um command.
2. **O nome diz o trabalho, nunca o dono.** /revisar-pr, não /ana-revisar-pr: quem executa é o agente da conversa, e ele pode mudar. Minúsculas e hífens, 2 a 48 caracteres, e não pode repetir o de outro command ou skill.
3. **Uma responsabilidade.** Dois trabalhos são dois commands.
4. **A descrição é o que a pessoa lê no autocompletar.** Uma frase: o que acontece quando ela dispara.
5. **Regra não mora no command.** O padrão a seguir está numa spec ou ADR: anexe (docIds), não copie.
6. **Nenhum segredo no corpo.** O corpo vai ao modelo e fica gravado na conversa.
7. **A trava mora no corpo.** Toda proibição do command fica no corpo, nunca só num documento anexado, e cita a exceção quando houver. O corpo não contradiz o que o documento anexado manda.

## O corpo
É o TEMPLATE que vai ao modelo — não um documento sobre o command.

- Escrito para o agente, no imperativo: o que fazer com o que a pessoa passou.
- **$ARGUMENTS** marca onde entra o que veio depois do /nome. Sem ele, os argumentos vão no fim. Diga o que fazer quando vier vazio.
- O critério de pronto e o formato da resposta, quando importam.
- ⛔ Sem cabeçalho de "agendamento", "frequência" ou "prompt de execução", e sem repetir o pedido duas vezes.

Exemplo:

\`\`\`markdown
Revise o pull request $ARGUMENTS (sem número: o mais recente aberto).
1. Leia o diff inteiro antes de comentar.
2. Confira contra a spec Padrões de API anexada: nomes, códigos de erro, paginação.
3. Para cada problema: arquivo e linha, o que está errado, a correção. Ordene do mais grave.
4. Termine com: aprovar, aprovar com ajustes ou pedir mudanças — e por quê.
\`\`\`

## Escopo
- Global vale em todos os projetos; o do projeto, só nele. Na dúvida, do projeto.
- Documento anexado tem de ser global ou do mesmo projeto do command.
- A pessoa só dispara o command num agente que o tenha liberado na guia Recursos.`,
}
