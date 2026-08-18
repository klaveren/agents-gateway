export interface IFileAttachment {
  name: string
  mimeType: string
  data: string // base64 encoded payload
}

export interface IMessageInput {
  text: string
  files?: IFileAttachment[]
}
