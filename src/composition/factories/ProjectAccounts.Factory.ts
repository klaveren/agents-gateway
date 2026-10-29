import { ProjectAccountsService } from '@application/ProjectAccounts.Service'
import { describeGitHubToken, GitHubAppTokens } from '@infra/accounts/GitHub.AppTokens'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteProjectAccountRepository } from '@infra/persistence/Sqlite.ProjectAccountRepository'
import { makeSecretBox } from './Credentials.Factory'

let instance: ProjectAccountsService | undefined

/** As contas dos projetos: uma instância só (o cache dos tokens de 1h é dela). */
export function makeProjectAccounts(): ProjectAccountsService {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  const github = new GitHubAppTokens()
  instance = new ProjectAccountsService(new SqliteProjectAccountRepository(makeSecretBox(), configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH), {
    githubApp: (key, grant) => github.token(key, grant),
    describeGitHub: (token, installation) => describeGitHubToken(token, installation),
  })
  return instance
}
