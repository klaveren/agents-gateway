import { runCatalogCli } from '../src/infra/catalog/Catalog.Cli'

// `pnpm catalog export|plan|apply <pasta> [--project <id> | --global]`: ver src/infra/catalog/Catalog.Cli.ts.
runCatalogCli(process.argv.slice(2), { env: process.env, fetch, log: (line) => console.log(line) })
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(`catalog: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
