export interface IFileAttachment {
  name: string
  mimeType: string
  data: string // base64 encoded payload
}

export interface IMessageInput {
  text: string
  files?: IFileAttachment[]
  /**
   * Contexto escrito PELO SISTEMA, não pela pessoa — quem está falando, a data de hoje.
   *
   * ⚖️ Vai antes do texto SÓ na primeira mensagem da sessão (a que ainda não tem turno): dali em
   * diante já está no histórico do modelo, e repeti-lo a cada turno pagaria os mesmos tokens para
   * dizer a mesma coisa. ⛔ NÃO É GRAVADO no turno — o registro guarda o que a pessoa escreveu, e o
   * título da conversa sai dele. Quem aplica isto é o `SendMessageUseCase`; o adapter nunca o vê.
   */
  context?: string
  /**
   * O que a pessoa DIGITOU, quando é outro que o `text` que vai ao modelo: um `/command` expandido. É o que o turno
   * grava e o título usa. Ausente = o próprio `text`.
   */
  recordAs?: string
}
