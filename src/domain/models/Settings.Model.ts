import { InvalidSettingsError } from '@domain/errors/Domain.Error'

/**
 * As decisões que mudam sem deploy.
 *
 * ⚖️ POR QUE ISTO EXISTE, se já há `.env` e código. Qual agente atende e com que modelo eram
 * escolhas do `Agent.Registry.ts` e de variáveis de ambiente — decisões de DEPLOY. Recolher o
 * agente porque está respondendo mal, ou trocar de modelo para comparar custo, são decisões de
 * OPERAÇÃO: se dependem de publicar, não são tomadas na hora em que importam.
 *
 * ⚠️ GLOBAIS. Valem para todas as sessões de uma vez. Configuração por chamador exigiria decidir
 * quem escolhe o modelo de quem, e essa pergunta não tem resposta útil enquanto não houver mais de
 * uma pessoa configurando.
 */

/**
 * Para quem o agente existe.
 *
 * ⚖️ SÃO TRÊS ESTADOS, não um liga-desliga, porque o meio é o que se usa de verdade: liberar para
 * um grupo pequeno e observar antes de expor a todos. Com dois estados, "testar em produção" e
 * "publicar para todos" viram a mesma alavanca.
 *
 *  · `off`        — ninguém abre conversa nova.
 *  · `restricted` — só quem tem um papel de `AUDIENCE_ROLES`, com a identidade PROVADA.
 *  · `all`        — qualquer chamador que o gateway já deixou passar.
 *
 * `DENIED_ROLES` recusa em QUALQUER uma delas, `all` incluído (ver `allowsCaller`).
 */
export type TAudience = 'off' | 'restricted' | 'all'

export const AUDIENCES: readonly TAudience[] = ['off', 'restricted', 'all']

export function isAudience(value: unknown): value is TAudience {
  return typeof value === 'string' && (AUDIENCES as readonly string[]).includes(value)
}

export interface IAgentSettings {
  /**
   * ⛔ Fechar a audiência impede SESSÃO NOVA; quem já estava conversando termina o turno em curso.
   * Matar turno no meio deixaria a pessoa com meia resposta e o registro de um erro que não foi
   * erro.
   */
  audience: TAudience

  /** Qual agente do registry atende. Vazio = o que o chamador pedir, ou o padrão do registry. */
  agentId?: string

  /** Modelo do agente. Vazio = o primeiro que o agente declara. */
  model?: string

  /**
   * O classificador de turno lê os dois A CADA TURNO (ver `ConfiguredTurnClassifier`): ligar, desligar
   * e trocar o modelo valem na hora, sem reiniciar. `classifyTurns` ausente é DESLIGADO; modelo vazio
   * cai em `CLASSIFIER_MODEL`, e sem nenhum dos dois não há classificação.
   */
  classifierModel?: string
  /**
   * O provider do modelo do classificador — um modelo ATIVADO no catálogo dele. Ausente, o provider é
   * deduzido do id do modelo (só funciona com os oficiais), como antes do catálogo.
   */
  classifierProvider?: string
  classifyTurns?: boolean

  updatedAt?: Date
  updatedBy?: string
}

/**
 * O que vale quando nada foi configurado.
 *
 * ⚖️ NASCE ABERTO (`all`). Configuração ausente não pode mudar o comportamento de quem já usava o
 * gateway antes de existir configuração; e um serviço que sobe desligado aparenta estar quebrado
 * no primeiro uso, com um sintoma — nenhuma resposta — que não aponta para configuração. O
 * perímetro de verdade é o portão de credencial e a prova de identidade, que não dependem disto.
 */
export const DEFAULT_SETTINGS: IAgentSettings = { audience: 'all' }

/**
 * Lê o que veio do armazenamento, aceitando o formato antigo.
 *
 * ⚖️ MIGRAÇÃO NA LEITURA, sem script. Antes de `audience` existia `enabled: boolean`:
 * `enabled: false` era "ninguém" e vira `off`; `true` ou ausente era "todos" e vira o padrão. Quem
 * gravou desligado continua desligado no primeiro boot depois da atualização — o erro caro seria
 * reabrir sozinho um agente que alguém tinha recolhido.
 *
 * Campo de tipo errado é descartado, não propagado: um documento editado à mão não derruba a
 * leitura (ver o contrato do repositório).
 */
export function normalizeSettings(raw: unknown): IAgentSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const stored = raw as Record<string, unknown>

  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)
  const date = (value: unknown): Date | undefined => {
    if (typeof value !== 'string' && !(value instanceof Date)) return undefined
    const parsed = new Date(value)

    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }

  const settings: IAgentSettings = {
    audience: isAudience(stored.audience) ? stored.audience : stored.enabled === false ? 'off' : DEFAULT_SETTINGS.audience,
    agentId: text(stored.agentId),
    model: text(stored.model),
    classifierModel: text(stored.classifierModel),
    classifierProvider: text(stored.classifierProvider),
    classifyTurns: typeof stored.classifyTurns === 'boolean' ? stored.classifyTurns : undefined,
    updatedAt: date(stored.updatedAt),
    updatedBy: text(stored.updatedBy),
  }

  // Sem chaves `undefined`: quem serializa e quem compara só enxerga o que existe.
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) as unknown as IAgentSettings
}

/**
 * Uma alteração parcial das configurações.
 *
 * ⚖️ `null` NÃO É "sem valor", é um PEDIDO: volte ao padrão do sistema. Sem ele, escolher um
 * modelo seria porta de mão única — dava para trocar por outro, nunca para desescolher.
 *
 * ⛔ Só campo OPCIONAL aceita `null`, e o tipo é quem garante: apagar `audience` deixaria o serviço
 * sem regra de quem alcança o agente — não existe padrão para o qual voltar.
 */
export type TSettingsChange = {
  [K in keyof IAgentSettings]?: undefined extends IAgentSettings[K] ? IAgentSettings[K] | null : IAgentSettings[K]
}

/** Os campos que quem salva controla. `updatedAt`/`updatedBy` são carimbo, não escolha. */
const EDITABLE = ['audience', 'agentId', 'model', 'classifierModel', 'classifierProvider', 'classifyTurns'] as const
const REQUIRED = ['audience'] as const

/**
 * O que fica gravado depois de uma alteração parcial.
 *
 * ⚖️ SÃO TRÊS ESTADOS, não dois. Campo AUSENTE não mexe no que está gravado — é o que permite à
 * tela mandar só o que mudou. Campo com VALOR troca. Campo NULO (ou texto vazio, que é o que um
 * `<select>` em branco manda) apaga, e volta ao padrão. Colapsar ausente e nulo no mesmo caso tira
 * da tela a única forma de desfazer uma escolha.
 *
 * ⛔ Nulo em campo OBRIGATÓRIO é recusado aqui, e não só no tipo: o tipo não vê JSON de fora.
 */
export function mergeSettings(current: IAgentSettings, changes: TSettingsChange, updatedBy?: string): IAgentSettings {
  const next: Record<string, unknown> = { ...current, updatedBy, updatedAt: new Date() }

  for (const field of EDITABLE) {
    const value = (changes as Record<string, unknown>)[field]
    if (value === undefined) continue

    const clearing = value === null || value === ''

    if (clearing && (REQUIRED as readonly string[]).includes(field)) throw new InvalidSettingsError(field)

    if (clearing) delete next[field]
    else next[field] = value
  }

  // ⚠️ Chave sem valor precisa SUMIR, não ficar `undefined`: um driver que serializa `undefined`
  // como `null` faria a leitura devolver um campo que ninguém configurou.
  for (const field of Object.keys(next)) if (next[field] === undefined) delete next[field]

  return next as unknown as IAgentSettings
}

/** O que a decisão de audiência precisa saber de quem chama. */
export interface IAudienceCaller {
  /** Há uma credencial com identidade legível. `false` = chamada anônima (só com `ALLOW_ANONYMOUS`). */
  identified: boolean
  /** A identidade foi CONFIRMADA pela prova — não só afirmada pelo token. */
  proven: boolean
  /** O papel que o token traz. Só vale para liberar quando `proven`. */
  role?: string
}

export interface IAudienceRules {
  /** Papéis admitidos sob `restricted`. */
  audienceRoles: readonly string[]
  /** Papéis recusados sob QUALQUER audiência. */
  deniedRoles: readonly string[]
  /** Espelha `REQUIRE_PROVEN_OWNER`: se identidade só afirmada basta sob `all`. */
  requireProven: boolean
}

/**
 * O agente atende quem chama?
 *
 * ⛔ A ORDEM É A REGRA.
 *  1. PAPEL RECUSADO vem antes de tudo — `all` não o abre, e `off` nem precisa. É uma recusa
 *     NOMEADA: depender de um efeito colateral de outra API (a prova falhar para aquele papel)
 *     abriria o acesso no dia em que esse acaso mudasse, sem nada quebrar. Para quem ainda não foi
 *     provado o papel é só o que o token afirma; recusar por afirmação é o lado seguro, mas não é
 *     defesa — quem a quer inteira configura a prova.
 *  2. `off` recusa todos.
 *  3. `restricted` exige identidade PROVADA e papel da lista. Papel de token não provado é texto
 *     escolhido por quem forjou o token: liberar por ele é entregar a porta a quem a quer.
 *  4. `all` admite o que o gateway já deixou passar, com UMA condição que acompanha a regra de dono
 *     (`REQUIRE_PROVEN_OWNER`): identidade apenas afirmada só entra se esse requisito foi desligado
 *     de propósito — com ele ligado, quem chega aqui sem prova já foi recusado antes. A chamada
 *     ANÔNIMA (sem credencial nenhuma) entra: só existe com `ALLOW_ANONYMOUS=1`, que é o uso local
 *     de uma pessoa e não tem identidade a forjar.
 */
export function allowsCaller(audience: TAudience, caller: IAudienceCaller, rules: IAudienceRules): boolean {
  const role = caller.role?.trim().toLowerCase()

  if (role && rules.deniedRoles.includes(role)) return false
  if (audience === 'off') return false

  if (audience === 'restricted') return caller.proven && role !== undefined && rules.audienceRoles.includes(role)

  if (audience === 'all') {
    if (!caller.identified) return true

    return caller.proven || !rules.requireProven
  }

  // Valor desconhecido (documento adulterado que escapou da normalização): fechado.
  return false
}
