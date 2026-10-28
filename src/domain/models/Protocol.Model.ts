import { TResourceKind } from './Resource.Model'

/**
 * Um PROTOCOLO: como um artefato agêntico (uma skill, um command) deve ser construído neste gateway.
 *
 * ⚖️ O DO CORE nasce no código e chega com a imagem — é o gateway que diz como o ambiente agêntico funciona. Quem
 * administra só SOMA um complemento (global ou do projeto), que vem DEPOIS do core e nunca o substitui: a próxima
 * versão do core continua valendo onde houver complemento.
 */
export type TProtocolKind = TResourceKind

export interface ICoreProtocol {
  kind: TProtocolKind
  /** Sobe à mão quando o texto muda: é o que a tela mostra para saber qual está em vigor. */
  version: string
  title: string
  /** Markdown. */
  body: string
}

/** O complemento de quem administra. Ausente o `projectId` = global. */
export interface IProtocolAddendum {
  kind: TProtocolKind
  projectId?: string
  body: string
  updatedAt: Date
  updatedBy?: string
}

/** O protocolo como vale num escopo: o do core e, depois dele, os complementos. */
export interface IProtocolView {
  core: ICoreProtocol
  addenda: { global?: IProtocolAddendum; project?: IProtocolAddendum }
}

export const PROTOCOL_ADDENDUM_MAX = 20_000
