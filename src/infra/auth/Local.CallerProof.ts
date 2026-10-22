import { ITokenIssuer } from '@domain/ports/TokenIssuer.Port'
import { IUserRepository } from '@domain/ports/UserRepository.Port'
import { ICallerProof } from '@infra/http/Caller.Proof'

/**
 * A prova do token emitido pelo próprio gateway.
 *
 * ⛔ A CONTA É RELIDA A CADA REQUISIÇÃO, e o token só vale se ainda bater com ela: conta ativa, mesmo
 * e-mail, MESMO PAPEL. Rebaixar um admin ou desativar uma conta derruba o token na hora — sem isso
 * ele continuaria abrindo as telas de operação até expirar. Sem cache de propósito: é uma leitura
 * por chave num arquivo local.
 */
export class LocalCallerProof implements ICallerProof {
  constructor(
    private readonly tokens: ITokenIssuer,
    private readonly users: IUserRepository,
  ) {}

  covers(token: string): boolean {
    return this.tokens.owns(token)
  }

  async prove(token: string): Promise<boolean> {
    const claims = this.tokens.verify(token)
    if (!claims) return false

    const user = this.users.findById(claims.sub)
    return !!user && !user.disabled && user.email === claims.email && user.role === claims.role
  }
}

/**
 * Local primeiro, externa depois: token deste gateway é conferido aqui; qualquer outro vai para a
 * prova configurada (`CALLER_PROOF_TOOL`), se houver.
 *
 * ⚠️ `covers` diz se ALGUMA prova responde pelo token. Sem prova externa, um token de fora não é
 * "recusado pela prova" — fica sem prova, e quem decide o que fazer com isso é `resolveCaller`
 * (`REQUIRE_PROVEN_OWNER`), como antes das contas locais existirem.
 */
export class CompositeCallerProof implements ICallerProof {
  constructor(
    private readonly local: LocalCallerProof,
    private readonly external?: ICallerProof,
  ) {}

  covers(token: string): boolean {
    return this.local.covers(token) || !!this.external
  }

  prove(token: string): Promise<boolean> {
    if (this.local.covers(token)) return this.local.prove(token)
    return this.external ? this.external.prove(token) : Promise.resolve(false)
  }
}
