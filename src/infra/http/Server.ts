import { makeController } from '@composition/factories/makeController'
import cors from 'cors'
import express, { Express, Response } from 'express'
import path from 'path'

export class HttpServer {
  public app: Express
  private hotReloadClients: Response[] = []

  constructor() {
    this.app = express()
    this.app.use(cors())
    this.app.use(express.json({ limit: '50mb' }))

    // Servir arquivos estáticos do frontend diretamente do Express
    const publicDir = path.join(process.cwd(), 'src/infra/http/public')
    this.app.use(express.static(publicDir))

    this.setupRoutes()
  }

  private setupRoutes() {
    const controller = makeController()

    this.app.get('/agents', controller.getAgents)
    this.app.post('/sessions', controller.createSession)
    this.app.post('/sessions/:agentId/:id/messages', controller.sendMessage)
    this.app.post('/sessions/:agentId/:id/cancel', controller.cancelSession)
  }

  start(port: number) {
    this.app.listen(port, () => {
      console.log(`Gateway API listening on port ${port}`)
    })
  }
}
