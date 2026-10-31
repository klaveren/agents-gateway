import { IImportConversationInput, IImportSourceFile, ImportBuildService } from '@application/ImportBuild.Service'
import { readRepoFile } from '@infra/import/Repo.Tree'
import { resolveWorkFolder } from '@infra/workspace/Work.Folder'
import { importJobRepository } from './ImportJobs.Factory'
import { makeProjects } from './Projects.Factory'
import { makeSecretMasker } from './SecretMask.Factory'

let instance: ImportBuildService | undefined
let opener: ((input: IImportConversationInput) => Promise<string>) | undefined

/**
 * O construtor em modo importação: UM serviço, para as rotas do Importador e para as ferramentas da conversa. A fonte é
 * lida do repositório DO projeto (`resolveWorkFolder`, a mesma contenção da varredura), mascarada.
 */
export function makeImportBuild(): ImportBuildService {
  instance ??= new ImportBuildService({
    repository: importJobRepository(),
    readSource: readImportSource,
    openConversation: (input) => {
      if (!opener) throw new Error('the builder conversation cannot be opened yet')
      return opener(input)
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

/** Quem abre a conversa (os casos de uso das conversas, montados com o controller de agentes). */
export function useImportOpener(open: (input: IImportConversationInput) => Promise<string>): void {
  opener = open
}
