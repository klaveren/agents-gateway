import { createHash } from 'node:crypto'
import { readPath } from '@infra/mcp/Caller.Identity'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'

/**
 * Como o gateway PROVA que uma credencial é real.
 *
 * ⚖️ UMA PORTA, e a implementação é detalhe. Hoje a prova é gastar o token numa tool-sonda do MCP
 * (`ToolProbeProof`); amanhã pode ser verificar a assinatura contra um JWKS. Quem consome — o
 * controller, o guard — só conhece `prove(token)`, então trocar a estratégia não toca em nenhuma
 * rota.
 *
 * ⛔ Contrato: `true` SÓ com confirmação positiva. Erro, timeout, resposta ilegível e dúvida são
 * `false`. Na dúvida, não é ninguém.
 */
export interface ICallerProof {
  prove(token: string): Promise<boolean>
  /**
   * Esta prova responde por ESTE token? Ausente = responde por todos (a prova por tool do MCP).
   *
   * ⚖️ É o que deixa as contas locais conviverem com a prova externa: token de fora, sem prova
   * externa configurada, cai na regra de sempre (`REQUIRE_PROVEN_OWNER`) em vez de ser recusado.
   */
  covers?(token: string): boolean
}

export const DEFAULT_PROOF_FIELD = 'authenticated'

/**
 * Quanto uma prova (ou recusa) vale sem nova ida à sonda.
 *
 * ⚖️ Sem cache, TODA requisição pagaria uma chamada ao MCP — uma tela que abre lista e histórico
 * junto dobraria a conta à toa. Com uma janela curta o custo é uma prova por token por minuto, e a
 * pior consequência de um token revogado é sobreviver menos de um minuto.
 */
export const PROOF_TTL_MS = 60_000

/** Teto do cache. Bem acima de qualquer uso real; existe para a memória não crescer sem limite. */
export const PROOF_MAX_ENTRIES = 500

/**
 * Prova gastando o token numa tool barata do MCP, que só responde com sucesso se o produto aceitar
 * a assinatura. Se aceitou, o payload inteiro é confiável — foi o produto que o emitiu.
 *
 * ⛔ AFIRMAÇÃO POSITIVA: só passa com `<field> === true` explícito no JSON da resposta. Negar pela
 * AUSÊNCIA de um `false` abriria a porta no dia em que a tool mudasse ou o campo fosse renomeado —
 * o padrão some, ninguém nega, e nada quebra no caminho feliz.
 */
export class ToolProbeProof implements ICallerProof {
  constructor(
    private readonly catalog: Pick<ToolCatalog, 'invoke'>,
    private readonly tool: string,
    private readonly field: string = DEFAULT_PROOF_FIELD,
  ) {}

  async prove(token: string): Promise<boolean> {
    try {
      const result = await this.catalog.invoke(this.tool, {}, { token })
      if (result.status !== 'success') return false

      return readPath(JSON.parse(String(result.result)), this.field) === true
    } catch {
      return false
    }
  }
}

export interface ICachedProofOptions {
  ttlMs?: number
  maxEntries?: number
  /** Injetável para o teste não precisar dormir. */
  now?: () => number
}

/**
 * Memoriza o resultado de qualquer estratégia, a recusa inclusive — um token inválido em laço não
 * vira uma chamada à sonda por requisição.
 *
 * ⚠️ A chave é o HASH, nunca o token: cache é estrutura longeva, e token em memória longeva vaza
 * num dump. Estourou o teto, sai a entrada mais antiga (e não tudo): limpar tudo deixaria quem
 * despeja 500 tokens lixo apagar a prova de todo mundo, a cada rodada.
 */
export class CachedProof implements ICallerProof {
  private readonly entries = new Map<string, { at: number; ok: boolean }>()
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(
    private readonly inner: ICallerProof,
    options: ICachedProofOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? PROOF_TTL_MS
    this.maxEntries = options.maxEntries ?? PROOF_MAX_ENTRIES
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  async prove(token: string): Promise<boolean> {
    const key = createHash('sha256').update(token).digest('hex')
    const cached = this.entries.get(key)
    if (cached && this.now() - cached.at < this.ttlMs) return cached.ok

    // Rajada do mesmo token compartilha uma prova só, em vez de uma por requisição.
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const work = this.inner
      .prove(token)
      .catch(() => false)
      .then((ok) => {
        this.entries.delete(key)
        while (this.entries.size >= this.maxEntries) {
          const oldest = this.entries.keys().next().value
          if (oldest === undefined) break
          this.entries.delete(oldest)
        }
        this.entries.set(key, { at: this.now(), ok })

        return ok
      })
      .finally(() => this.pending.delete(key))

    this.pending.set(key, work)
    return work
  }
}

/**
 * A estratégia de prova configurada, ou `undefined` — e `undefined` DESLIGA a prova.
 *
 * ⚖️ SEM `CALLER_PROOF_TOOL` NÃO HÁ PADRÃO. O gateway é agnóstico: não sabe qual tool do seu MCP
 * confirma uma credencial, e adivinhar uma faria toda instalação gastar o token numa tool que pode
 * nem existir — e recusar todo mundo.
 */
export function proofFromEnv(catalog: Pick<ToolCatalog, 'invoke'>, env: NodeJS.ProcessEnv = process.env): ICallerProof | undefined {
  const tool = env.CALLER_PROOF_TOOL?.trim()
  if (!tool) return undefined

  return new CachedProof(new ToolProbeProof(catalog, tool, env.CALLER_PROOF_FIELD?.trim() || DEFAULT_PROOF_FIELD))
}

let warned = false

/**
 * Avisa UMA vez, no boot, que a identidade não está sendo provada.
 *
 * ⚠️ Sem prova, o que o token diz ser é só o que ele diz. O aviso existe porque o modo desligado é
 * seguro por recusa (ver `Caller.Access`) — e recusa silenciosa parece defeito.
 */
export function warnIfProofDisabled(proof: ICallerProof | undefined, log: (message: string) => void = console.warn): void {
  if (proof || warned) return
  warned = true

  log(
    '[auth] CALLER_PROOF_TOOL não definido: a identidade do chamador é apenas AFIRMADA pelo token. Rotas que exigem identidade provada recusam credencial; ' +
      'defina CALLER_PROOF_TOOL, ou REQUIRE_PROVEN_OWNER=0 só em rede confiável.',
  )
}

/** Só para teste: o aviso é de uma vez por processo, e um caso mascararia o outro. */
export function resetProofWarning(): void {
  warned = false
}
