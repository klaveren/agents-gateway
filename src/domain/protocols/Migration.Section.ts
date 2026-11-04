/**
 * O FIM COMUM dos protocolos: migrar de outro ambiente POR FORA do Importador (o agente lê o repositório e grava com
 * `save_*`). Uma seção só, igual em todos — o que muda de um tipo para outro já está no protocolo dele.
 */
export const MIGRATION_SECTION = `## Migração (fora do Importador)
Quando o artefato vem do repositório e você o grava direto (não pela revisão do Importador): leia a fonte inteira, ajuste ao padrão deste protocolo (aqui reescrever é permitido), confira no código cada nome que o texto cita antes de gravar, e grave com \`importedFrom: { path }\` (o arquivo principal da fonte: é o que tira o item da fila do Importador) e \`tags\` do grupo. Resposta com \`importer.marked: false\` traz o motivo: corrija e grave de novo.`
