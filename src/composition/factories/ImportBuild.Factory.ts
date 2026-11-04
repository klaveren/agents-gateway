import { IImportConversationInput, IImportRepositoryFiles, IImportSourceFile, ImportBuildService } from '@application/ImportBuild.Service'
import { IImportTurnResult, ImportRunService } from '@application/ImportRun.Service'
import { listRepoFiles, readRepoFile, readRepoText } from '@infra/import/Repo.Tree'
import { listRepositories, resolveWorkFolder } from '@infra/workspace/Work.Folder'
import { RepositoryBrowseService } from '@application/RepositoryBrowse.Service'
import { makeGuidance } from './Guidance.Factory'
import { importJobRepository } from './ImportJobs.Factory'
import { makeProjects } from './Projects.Factory'
import { makeSecretMasker } from './SecretMask.Factory'

let instance: ImportBuildService | undefined
let opener: ((input: IImportConversationInput) => Promise<string>) | undefined
let runs: ImportRunService | undefined
let turns: ((conversationId: string, message: string) => () => Promise<IImportTurnResult>) | undefined

/**
 * O construtor em modo importação: UM serviço, para as rotas do Importador e para as ferramentas da conversa. A fonte é
 * lida do repositório DO projeto (`resolveWorkFolder`, a mesma contenção da varredura), mascarada.
 */
export function makeImportBuild(): ImportBuildService {
  instance ??= new ImportBuildService({
    repository: importJobRepository(),
    readSource: readImportSource,
    repositoryFiles: importRepositoryFiles(),
    projectIgnore: (projectId) => makeProjects().importIgnore(projectId),
    projectScope: (projectId) => makeProjects().importScope(projectId),
    openConversation: (input) => {
      if (!opener) throw new Error('the builder conversation cannot be opened yet')
      return opener(input)
    },
    docExists: (id, projectId) => {
      try {
        const doc = makeGuidance().doc(id)
        return !doc.projectId || doc.projectId === projectId
      } catch {
        return false
      }
    },
  })
  return instance
}

/**
 * ⛔ Um arquivo do repositório DO projeto (`resolveWorkFolder`, a mesma contenção da varredura), mascarado. É a leitura
 * do construtor e a da gravação (que confere o rascunho de novo contra o disco).
 */
export function readImportSource(projectId: string, repository: string, path: string): IImportSourceFile | undefined {
  const masker = makeSecretMasker()
  try {
    return readRepoFile(resolveWorkFolder(makeProjects().folderOf(projectId), repository).dir, path, { mask: (text) => masker.text(text) })
  } catch {
    // O repositório sumiu do projeto: para a importação, a fonte não existe mais.
    return undefined
  }
}

/**
 * ⛔ A navegação do construtor: o repositório DO projeto (`resolveWorkFolder`, a mesma contenção da varredura), só
 * leitura, mascarada. Lança quando o repositório não é do projeto (o serviço devolve o erro à ferramenta).
 */
function importRepositoryFiles(): IImportRepositoryFiles {
  const dir = (projectId: string, repository: string) => resolveWorkFolder(makeProjects().folderOf(projectId), repository).dir
  return {
    list: (projectId, repository, under, exclude) => listRepoFiles(dir(projectId, repository), under, exclude),
    read: (projectId, repository, path, exclude) => {
      const masker = makeSecretMasker()
      return readRepoText(dir(projectId, repository), path, { mask: (text) => masker.text(text), exclude })
    },
  }
}

/** Quem abre a conversa (os casos de uso das conversas, montados com o controller de agentes). */
export function useImportOpener(open: (input: IImportConversationInput) => Promise<string>): void {
  opener = open
}

/** O construtor em segundo plano (o "Preparar tudo"): UMA fila no gateway, com o turno dos casos de uso das conversas. */
export function makeImportRuns(): ImportRunService {
  runs ??= new ImportRunService({
    prepareTurn: (conversationId, message) => {
      if (!turns) throw new Error('the builder turn cannot run yet')
      return turns(conversationId, message)
    },
  })
  return runs
}

/** Quem roda o turno de fundo (o controller de agentes, no contexto de quem pediu). */
export function useImportTurns(prepare: (conversationId: string, message: string) => () => Promise<IImportTurnResult>): void {
  turns = prepare
}

let browse: RepositoryBrowseService | undefined

/**
 * A leitura do repositório pelo CONSTRUTOR do tipo (fora do Importador): o mesmo repositório do projeto e a mesma
 * contenção, mascarada — com o código, para conferir o que a fonte cita antes de gravar.
 */
export function makeRepositoryBrowse(): RepositoryBrowseService {
  browse ??= new RepositoryBrowseService({
    files: importRepositoryFiles(),
    repositories: (projectId) => {
      try {
        return listRepositories(makeProjects().folderOf(projectId)).map((item) => item.name)
      } catch {
        return []
      }
    },
    projectIgnore: (projectId) => makeProjects().importIgnore(projectId),
  })
  return browse
}
