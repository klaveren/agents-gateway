import { ICoreProtocol } from '@domain/models/Protocol.Model'

/** O protocolo do core para construir uma ADR. ⚠️ Mudou o texto, sobe a versão. */
export const ADR_PROTOCOL: ICoreProtocol = {
  kind: 'adr',
  version: '1.1.1',
  title: 'Protocolo de construção de ADR',
  body: `# Protocolo de construção de ADR

Uma ADR registra UMA DECISÃO e o PORQUÊ. A conversa recebe só o índice e o agente a lê com read_doc quando precisa entender por que algo é como é — e não propor de novo o que já foi descartado.

## Princípios
1. **Uma decisão por ADR.** Duas decisões são duas ADRs, cada uma com o seu porquê.
2. **Status no corpo.** Proposta, Aceita, Rejeitada ou Substituída por <id>. A ADR nunca é reescrita para mudar a decisão: uma ADR nova a substitui, e a antiga ganha "Substituída por <id>".
3. **Datada.** A data da decisão no corpo: o contexto de hoje não é o de amanhã.
4. **O contexto é o que forçou a decisão.** Fatos e restrições, medidos quando der — não a narrativa de quem fez o quê.
5. **As alternativas importam tanto quanto a escolha.** O que foi considerado e por que perdeu: é o que impede alguém de reabrir a mesma discussão.
6. **As consequências incluem o custo.** O que fica mais fácil, o que fica mais difícil, o que passa a ser obrigatório.
7. **A regra que sai da decisão mora numa spec.** A ADR explica; a spec manda. Cite a spec pelo id.
8. **O id diz a decisão.** Minúsculas e hífens ("adr-sqlite-como-banco"). O resumo, uma linha: o que se decidiu.
9. **A decisão merece spec?** Quatro perguntas: muda como o trabalho é feito? Vale além deste caso? Ficaria escondida se morasse só na ADR? É regra que atravessa o ambiente? 0 ou 1 "sim": fica só na ADR. 2: reforce a spec que já trata do assunto. 3 ou 4: crie ou atualize a spec — e a ADR a cita pelo id.

## O corpo
\`\`\`markdown
# <Título da decisão>

**Status:** Aceita · **Data:** AAAA-MM-DD

## Contexto
<o problema e as restrições que forçaram a decisão>

## Decisão
<o que se decidiu, em uma ou duas frases>

## Alternativas consideradas
- <alternativa> — <por que não>

## Consequências
- <o que melhora>
- <o que custa ou passa a ser obrigatório>
\`\`\`

## Escopo
- Global vale em todos os projetos; a do projeto, só nele. Na dúvida, do projeto.
- Relação com outro documento é ANEXO no painel (docIds; o grande, por referência em docRefs), nunca caminho de arquivo citado no texto.`,
}
