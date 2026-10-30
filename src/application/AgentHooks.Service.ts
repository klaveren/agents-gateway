import { randomBytes } from 'node:crypto'
import { HookNotFoundError, InvalidHookError } from '@domain/errors/Domain.Error'
import { HOOK_DEFAULTS, HOOK_NAME_PATTERN, hookSecretKey, IAgentHook, IHookDelivery, THookSession, THookVerify } from '@domain/models/AgentHook.Model'
import { IAgentHookRepository } from '@domain/ports/AgentHookRepository.Port'
import { ICredentialStore } from '@domain/ports/CredentialStore.Port'

export interface IHookInput {
  name: string
  prompt: string
  enabled?: boolean
  verify?: THookVerify
  signatureHeader?: string
  signaturePrefix?: string
  signatureEncoding?: 'hex' | 'base64'
  session?: THookSession
}

export type THookChange = Partial<Omit<IHookInput, 'name'>>

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const VERIFIES: THookVerify[] = ['key', 'hmac']
const SESSIONS: THookSession[] = ['new', 'continuous']

/**
 * O cadastro dos hooks de cada agente.
 *
 * ⛔ A CHAVE SÓ SAI UMA VEZ: gerada aqui, guardada cifrada no cofre (`hook:<agente>/<hook>`) — a assinatura
 * HMAC precisa do valor, então hash não serve — e devolvida só ao criar e ao trocar. Depois, os 4 últimos.
 */
export class AgentHooksService {
  constructor(
    private readonly hooks: IAgentHookRepository,
    private readonly secrets: ICredentialStore,
    private readonly agentExists: (agentId: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(agentId: string): IAgentHook[] {
    return this.hooks.list(agentId)
  }

  get(agentId: string, name: string): IAgentHook {
    const hook = this.hooks.get(agentId, name)
    if (!hook) throw new HookNotFoundError(agentId, name)
    return hook
  }

  /** O hook ligado de um agente que existe — o que a rota pública atende. `undefined` = 404. */
  active(agentId: string, name: string): IAgentHook | undefined {
    const hook = this.hooks.get(agentId, name)
    return hook?.enabled && this.agentExists(agentId) ? hook : undefined
  }

  secretOf(agentId: string, name: string): string | undefined {
    return this.secrets.get(hookSecretKey(agentId, name))
  }

  secretLast4(agentId: string, name: string): string | undefined {
    return this.secrets.status([hookSecretKey(agentId, name)])[0]?.last4
  }

  create(agentId: string, input: IHookInput, by: { userId: string; label: string }): { hook: IAgentHook; secret: string } {
    if (!this.agentExists(agentId)) throw new InvalidHookError([{ field: 'agentId', message: `no such agent: ${agentId}` }])
    const hook: IAgentHook = {
      agentId,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      enabled: input.enabled ?? true,
      verify: input.verify ?? 'key',
      signatureHeader: input.signatureHeader?.trim() || HOOK_DEFAULTS.signatureHeader,
      signaturePrefix: input.signaturePrefix ?? HOOK_DEFAULTS.signaturePrefix,
      signatureEncoding: input.signatureEncoding ?? HOOK_DEFAULTS.signatureEncoding,
      session: input.session ?? 'new',
      runAs: by.userId,
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by.label,
    }
    const issues = issuesOf(hook)
    if (!HOOK_NAME_PATTERN.test(hook.name)) issues.unshift({ field: 'name', message: 'use 2–48 lowercase letters, digits or hyphens' })
    else if (this.hooks.get(agentId, hook.name)) issues.unshift({ field: 'name', message: `already exists: ${hook.name}` })
    if (issues.length) throw new InvalidHookError(issues)

    this.hooks.insert(hook)
    return { hook, secret: this.newSecret(hook, by.label) }
  }

  update(agentId: string, name: string, change: THookChange, by: string): IAgentHook {
    const current = this.get(agentId, name)
    const next: IAgentHook = { ...current, ...definedOnly(change), updatedAt: this.now(), updatedBy: by }
    next.prompt = next.prompt.trim()
    next.signatureHeader = next.signatureHeader.trim() || HOOK_DEFAULTS.signatureHeader
    const issues = issuesOf(next)
    if (issues.length) throw new InvalidHookError(issues)
    // Sair de `continuous` larga a conversa: voltar depois começa uma nova.
    return this.hooks.update(agentId, name, {
      ...definedOnly(change),
      prompt: next.prompt,
      signatureHeader: next.signatureHeader,
      ...(next.session === 'new' ? { sessionId: undefined } : {}),
      updatedAt: next.updatedAt,
      updatedBy: by,
    })!
  }

  /** A conversa de um hook `continuous` (quando nasce, ou quando a anterior sumiu). */
  setSession(agentId: string, name: string, sessionId: string): void {
    this.hooks.update(agentId, name, { sessionId })
  }

  rotate(agentId: string, name: string, by: string): string {
    return this.newSecret(this.get(agentId, name), by)
  }

  remove(agentId: string, name: string): void {
    this.get(agentId, name)
    this.hooks.delete(agentId, name)
    this.secrets.clear(hookSecretKey(agentId, name))
  }

  /** O agente foi apagado: os hooks e as chaves dele vão junto. */
  removeAgent(agentId: string): void {
    for (const name of this.hooks.deleteAgent(agentId)) this.secrets.clear(hookSecretKey(agentId, name))
  }

  deliveries(agentId: string, name: string): IHookDelivery[] {
    this.get(agentId, name)
    return this.hooks.deliveries(agentId, name)
  }

  recordDelivery(hook: IAgentHook): IHookDelivery {
    const delivery: IHookDelivery = { id: `hkd_${randomBytes(9).toString('base64url')}`, agentId: hook.agentId, hookName: hook.name, receivedAt: this.now(), status: 'running' }
    this.hooks.addDelivery(delivery)
    return delivery
  }

  finishDelivery(id: string, patch: Partial<Pick<IHookDelivery, 'status' | 'sessionId' | 'error'>>): void {
    this.hooks.updateDelivery(id, patch)
  }

  private newSecret(hook: IAgentHook, by: string): string {
    const secret = `whk_${randomBytes(32).toString('base64url')}`
    this.secrets.save(hookSecretKey(hook.agentId, hook.name), secret, by)
    return secret
  }
}

function issuesOf(hook: IAgentHook): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  // ⚖️ O prompt não tem teto: o tamanho é de quem cria o hook.
  if (!hook.prompt) issues.push({ field: 'prompt', message: 'required: what the agent does when the event arrives' })
  if (!VERIFIES.includes(hook.verify)) issues.push({ field: 'verify', message: `one of ${VERIFIES.join(', ')}` })
  if (!SESSIONS.includes(hook.session)) issues.push({ field: 'session', message: `one of ${SESSIONS.join(', ')}` })
  if (!HEADER_NAME.test(hook.signatureHeader)) issues.push({ field: 'signatureHeader', message: 'letters, digits and hyphens' })
  if (hook.signaturePrefix.length > 32 || /[\s\r\n]/.test(hook.signaturePrefix)) issues.push({ field: 'signaturePrefix', message: 'up to 32 characters, no spaces' })
  if (hook.signatureEncoding !== 'hex' && hook.signatureEncoding !== 'base64') issues.push({ field: 'signatureEncoding', message: 'hex or base64' })
  return issues
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}
