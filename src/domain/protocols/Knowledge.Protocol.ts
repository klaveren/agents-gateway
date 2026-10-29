import { ICoreProtocol } from '@domain/models/Protocol.Model'

/** O protocolo do core para construir CONHECIMENTO (o estudo de um tema). ⚠️ Mudou o texto, sobe a versão. */
export const KNOWLEDGE_PROTOCOL: ICoreProtocol = {
  kind: 'knowledge',
  version: '1.0.0',
  title: 'Protocolo de construção de conhecimento',
  body: `# Protocolo de construção de conhecimento

Conhecimento é a SÍNTESE de um tema a partir de fontes canônicas e externas — livros, papers, documentação oficial, padrões, autores primários. É a base sólida e atualizada que vem ANTES de escrever uma spec, uma skill ou uma ADR: quem for decidir lê o estudo, não a internet de novo. A conversa recebe só o índice (id, título e resumo) e o agente lê o estudo inteiro com read_doc quando o assunto aparece.

## 0. Classifique antes de pesquisar
É conhecimento quando o sujeito é um tema do mundo (um padrão, uma técnica, uma tecnologia, um conceito). NÃO é:
- descoberta sobre o nosso próprio sistema → é spec (como ele deve ser) ou parte do trabalho;
- uma decisão tomada → é ADR;
- uma regra a cumprir → é rule ou spec.
O código real entra só como VALIDAÇÃO do que as fontes dizem, nunca como o sujeito do estudo. Se não for conhecimento, diga o que é e pare.

## 1. Não duplique
Antes de pesquisar, confira o que já existe (o índice "O que já existe" e os documentos de referência). O tema já tem estudo? ATUALIZE o existente (o mesmo id) em vez de criar outro. Um estudo por tema — nunca um documento-mamute com vários.

## 2. Fontes, nesta ordem
1. Livros canônicos (O'Reilly, Addison-Wesley, Pragmatic, IEEE Press).
2. Papers (arXiv, ACM, IEEE, USENIX).
3. Documentação oficial e padrões (a do fornecedor, RFC, ISO, W3C).
4. Artigos de autores primários (o blog de quem criou o conceito).
5. O código real, só para validar.
Para cada fonte: confirme que é primária (não um resumo de terceiro, não blog de SEO), extraia conceitos e não opiniões, e anote a URL e a data de acesso. Leia a fonte — não cite o que você só viu num trecho de busca.

## 3. Síntese
Para o tema, estabeleça: a definição formal (segundo a fonte primária), o problema que resolve, os componentes, a relação com o que já existe aqui (outros estudos, specs, ADRs), onde se aplica neste ambiente e o que ainda não se sabe (as lacunas).

## 4. O corpo
Impessoal, técnico, no presente — uma biblioteca de referência, nunca um diário ("aprendi", "mudei de ideia" não entram). Só entregue quando estiver completo: estudo pela metade não é conhecimento.

\`\`\`markdown
# <Tema>

<Parágrafo direto que define o conceito, segundo a fonte primária.>

## O problema que resolve
- …

## Componentes / como funciona
- …

## Quando usar e quando não usar
- ✅ …
- ⛔ …

## Onde se aplica aqui
<Como o conceito se conecta a este ambiente: que specs, ADRs, skills ou agentes ele fundamenta ou deveria fundamentar.>

## Lacunas
- <o que as fontes não respondem, ou o que ainda precisa ser medido aqui>

## Fontes
- <Autor, ano. Título. URL — acessado em AAAA-MM-DD>
\`\`\`

## Identificação
- id em slug que diz o tema ("feature-flags", "arquitetura-hexagonal").
- Resumo de uma linha: o que o estudo cobre — é o que aparece no índice de toda conversa.
- Escopo: global (vale em todos os projetos) quando o tema é geral; do projeto quando é específico dele. Na dúvida, global.`,
}
