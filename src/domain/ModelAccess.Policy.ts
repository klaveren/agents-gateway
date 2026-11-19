import { IProjectModels, TProjectRole } from './models/Project.Model'

/**
 * 🔐 QUEM USA QUAL MODELO (ver `docs/integration/plano-modelos-por-projeto.md`). Três camadas, e cada uma só RESTRINGE o
 * que recebeu de cima:
 *  1. o gateway liga o modelo no catálogo (`ModelCatalog`);
 *  2. o admin do GATEWAY libera ao projeto (`IProjectModels.allowed`);
 *  3. o admin do PROJETO libera a cada papel ou pessoa (`byRole`, `byUser`; a da pessoa vence a do papel).
 * ⚖️ Lista AUSENTE = tudo o que vem de cima: quem não configurou nada continua como antes.
 */

/** A chave de um modelo: `provider/modelo` (o modelo pode ter `/`, o provider não). */
export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** `provider/modelo` → as duas partes; `undefined` = sem `/` ou parte vazia. */
export function parseModelKey(key: string): { provider: string; model: string } | undefined {
  const slash = key.indexOf('/')
  if (slash <= 0 || slash === key.length - 1) return undefined
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) }
}

/** O admin do gateway liberou este modelo ao projeto? Sem lista, tudo o que o gateway liga. */
export function projectAllows(models: IProjectModels | undefined, provider: string, model: string): boolean {
  return !models?.allowed || models.allowed.includes(modelKey(provider, model))
}

/** A lista que vale para a pessoa no projeto (a dela vence a do papel); `undefined` = tudo o que o projeto recebeu. */
export function memberList(models: IProjectModels | undefined, member: { userId?: string; role?: TProjectRole }): readonly string[] | undefined {
  if (member.userId && models?.byUser?.[member.userId]) return models.byUser[member.userId]
  if (member.role && models?.byRole?.[member.role]) return models.byRole[member.role]
  return undefined
}

/**
 * A pessoa pode usar este modelo neste projeto? O projeto tem de ter recebido E a lista dela (ou do papel) incluir.
 * Sem pessoa (agendamento, hook, integração sem conta), vale só o que o projeto recebeu.
 */
export function memberAllows(models: IProjectModels | undefined, member: { userId?: string; role?: TProjectRole }, provider: string, model: string): boolean {
  if (!projectAllows(models, provider, model)) return false
  const list = memberList(models, member)
  return !list || list.includes(modelKey(provider, model))
}

/** O que há de errado numa lista de modelos (chave sem `provider/`, repetida). */
export function modelListIssues(field: string, list: readonly string[]): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  const seen = new Set<string>()
  for (const key of list) {
    if (!parseModelKey(key)) issues.push({ field, message: `"${key}" is not provider/model` })
    else if (seen.has(key)) issues.push({ field, message: `"${key}" is repeated` })
    seen.add(key)
  }
  return issues
}

/**
 * ⛔ O admin do projeto só RESTRINGE: a lista de um papel ou pessoa tem de caber no que o projeto recebeu. O que o gateway
 * tirou depois sai da lista sozinho na leitura (ver `memberAllows`), sem invalidar o que já estava salvo.
 */
export function memberModelsIssues(
  allowed: readonly string[] | undefined,
  members: Pick<IProjectModels, 'byRole' | 'byUser'>,
  /** O modelo de um provider do próprio projeto: fica fora da lista do gateway. */
  own: (key: string) => boolean = () => false,
): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  const check = (field: string, list: readonly string[]) => {
    issues.push(...modelListIssues(field, list))
    if (allowed) for (const key of list) if (!allowed.includes(key) && !own(key)) issues.push({ field, message: `"${key}" was not released to this project` })
  }
  for (const [role, list] of Object.entries(members.byRole ?? {})) if (list) check(`byRole.${role}`, list)
  for (const [userId, list] of Object.entries(members.byUser ?? {})) check(`byUser.${userId}`, list)
  return issues
}

/**
 * 🔐 O filtro de UMA conversa: pode este `provider/modelo`? `ownerOf` diz o projeto dono do provider (o provider de
 * projeto, fase 2). ⛔ O provider de um projeto só roda em conversa dele — e lá a lista do gateway não vale (o provider é
 * do projeto), só a do papel ou da pessoa. Conversa sem projeto: nenhum provider de projeto.
 */
export function conversationModelFilter(
  projectId: string | undefined,
  models: IProjectModels | undefined,
  member: { userId?: string; role?: TProjectRole },
  ownerOf: (provider: string) => string | undefined,
): (provider: string, model: string) => boolean {
  return (provider, model) => {
    const owner = ownerOf(provider)
    if (!projectId) return !owner
    if (owner) return owner === projectId && memberAllows({ ...models, allowed: undefined }, member, provider, model)
    return memberAllows(models, member, provider, model)
  }
}
