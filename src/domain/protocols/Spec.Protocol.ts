import { ICoreProtocol } from '@domain/models/Protocol.Model'

/** O protocolo do core para construir uma SPEC. ⚠️ Mudou o texto, sobe a versão. */
export const SPEC_PROTOCOL: ICoreProtocol = {
  kind: 'spec',
  version: '1.1.0',
  title: 'Protocolo de construção de spec',
  body: `# Protocolo de construção de spec

Uma spec diz COMO ALGO DEVE SER: um padrão, um contrato, um conceito. A conversa recebe só o índice (id, título e resumo) e o agente lê a spec inteira com read_doc quando o assunto aparece; a marcada no contexto inicial do projeto ou do agente vai inteira no prompt. Skills e commands a anexam em vez de repetir as regras dela.

## Princípios
1. **Fonte única.** Uma regra mora em UMA spec. Se outra spec já trata do assunto, ajuste-a ou cite-a pelo id — nunca copie. Duas versões da mesma regra divergem no primeiro toque.
2. **O resumo é o gatilho.** Uma linha concreta do que a spec cobre: é a única coisa que o agente lê antes de decidir abri-la.
3. **O id diz o assunto.** Minúsculas e hífens ("padroes-api-rest"). Ele não muda depois: skills e commands apontam para ele.
4. **Regra, não história.** O que vale, no presente. Por que se decidiu assim é uma ADR — cite-a pelo id quando ajudar.
5. **Verificável.** Cada regra permite dizer se algo está conforme ou não. Exemplo bom e exemplo ruim quando a regra deixa dúvida.
6. **Nenhum segredo.** Nome da variável ou da credencial, nunca o valor.
7. **Do tamanho do assunto.** Se ela vai para o contexto inicial, cada palavra pesa em toda conversa do projeto: corte o que não muda decisão.
8. **Diga quem a carrega.** No topo: se vai no contexto inicial (de qual projeto ou de quais agentes) ou só sob demanda, pelo índice. Spec que cresce sem parar (histórico, registro) nunca vai no contexto inicial.
9. **Regra superada sai.** A spec descreve só o que vale. Regra substituída é apagada, sem "obsoleto" ou "substituída por" — senão um agente aplica a regra morta. O porquê da troca é uma ADR.
10. **Poucas, por tema.** Uma spec por tema durável, nunca uma por caso. O assunto já tem spec? Ajuste-a.

## O corpo
\`\`\`markdown
# <Título>

**Objetivo:** <uma frase — o que esta spec garante>.
**Quem carrega:** <contexto inicial de … | sob demanda, pelo índice>

## Regras
1. <regra verificável>
2. …

## Exemplos
- ✅ <conforme>
- ⛔ <não conforme, e por quê>

## Fora do escopo
- <o que esta spec não cobre, e onde está (id de outra spec ou ADR)>
\`\`\`

## Escopo
- Global vale em todos os projetos; a do projeto, só nele. Na dúvida, do projeto.`,
}
