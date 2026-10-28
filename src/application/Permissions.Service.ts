import { cleanRules, decide, IPermissionRule, IPermissionSubject, IPermissionVerdict, permissionIssues } from '@domain/Permission.Policy'
import { InvalidPermissionsError } from '@domain/errors/Domain.Error'
import { IPermissionDecision, IPermissionRepository } from '@domain/ports/PermissionRepository.Port'

/** Quem pede: o agente que está respondendo, na conversa de que projeto. */
export interface IPermissionAsker {
  agentId?: string
  /** O projeto da CONVERSA (o Atlas, global, numa conversa do XPTO segue as regras do XPTO). */
  projectId?: string
  sessionId?: string
}

/** Quem confere as permissões no ponto que executa (ferramentas, hook do Claude, catálogo de MCP). */
export interface IPermissionChecker {
  /** `log`: registra a decisão (na execução, sim; ao montar a lista de ferramentas, não). */
  check(asker: IPermissionAsker, subject: IPermissionSubject, options?: { log?: boolean }): IPermissionVerdict
}

/**
 * As permissões dos agentes: as regras de cada projeto, as de cada agente (no cadastro dele), a decisão e o registro.
 * A política (camadas, quem vence) mora em `Permission.Policy`; aqui, de onde vêm as regras e para onde vai a decisão.
 */
export class PermissionsService implements IPermissionChecker {
  constructor(
    private readonly repository: IPermissionRepository,
    private readonly agentRules: (agentId: string) => readonly IPermissionRule[] | undefined,
    /** Regras de sistema da instalação (a pasta de dados do gateway, em caminho absoluto). */
    private readonly system: () => readonly IPermissionRule[] = () => [],
    private readonly now: () => Date = () => new Date(),
  ) {}

  projectRules(projectId: string) {
    return this.repository.projectRules(projectId)
  }

  saveProjectRules(projectId: string, rules: unknown, by: string): IPermissionRule[] {
    const issues = permissionIssues(rules)
    if (issues.length) throw new InvalidPermissionsError(issues)
    const clean = cleanRules(rules as IPermissionRule[])
    this.repository.saveProjectRules(projectId, clean, by)
    return clean
  }

  check(asker: IPermissionAsker, subject: IPermissionSubject, options: { log?: boolean } = {}): IPermissionVerdict {
    const verdict = this.evaluate(asker, subject)
    if (options.log) this.record(asker, subject, verdict)
    return verdict
  }

  /** O testador da tela: a mesma decisão, sem registrar. */
  test(asker: IPermissionAsker, subject: IPermissionSubject): IPermissionVerdict {
    return this.evaluate(asker, subject)
  }

  decisions(projectId: string, options?: { agentId?: string; limit?: number }): IPermissionDecision[] {
    return this.repository.decisions(projectId, options)
  }

  removeProject(projectId: string): void {
    this.repository.deleteProject(projectId)
  }

  private evaluate(asker: IPermissionAsker, subject: IPermissionSubject): IPermissionVerdict {
    const agent = asker.agentId ? this.agentRules(asker.agentId) : undefined
    const project = asker.projectId ? this.repository.projectRules(asker.projectId).rules : undefined
    return decide(subject, { ...(agent ? { agent } : {}), ...(project ? { project } : {}) }, this.system())
  }

  private record(asker: IPermissionAsker, subject: IPermissionSubject, verdict: IPermissionVerdict): void {
    // ⚖️ Registrar nunca derruba a ferramenta: a decisão já foi tomada.
    try {
      this.repository.logDecision({
        at: this.now(),
        ...(asker.projectId ? { projectId: asker.projectId } : {}),
        ...(asker.agentId ? { agentId: asker.agentId } : {}),
        ...(asker.sessionId ? { sessionId: asker.sessionId } : {}),
        category: subject.category,
        subject: subject.value,
        allowed: verdict.allowed,
        layer: verdict.layer,
        ...(verdict.rule ? { pattern: verdict.rule.pattern } : {}),
      })
    } catch (error) {
      console.warn('[permissões] não foi possível registrar a decisão:', error)
    }
  }
}
