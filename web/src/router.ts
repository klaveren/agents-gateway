import { createRouter, createWebHistory } from 'vue-router'
import AgentsView from './views/AgentsView.vue'
import InboxView from './views/InboxView.vue'
import AuthView from './views/AuthView.vue'
import ProvidersView from './views/ProvidersView.vue'
import SettingsView from './views/SettingsView.vue'
import UsersView from './views/UsersView.vue'

/**
 * ⚠️ HISTÓRICO DE VERDADE (`/c/:id`), não `#`: o link de uma conversa é colável. O gateway devolve o
 * `index.html` para qualquer rota que não seja da API (ver `Http.Server`).
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'inbox', component: InboxView },
    { path: '/c/:id', name: 'conversation', component: InboxView, props: true },
    { path: '/new', name: 'new', component: InboxView },
    { path: '/agents', name: 'agents', component: AgentsView },
    { path: '/agents/new', name: 'agent-new', component: AgentsView },
    { path: '/agents/:id', name: 'agent', component: AgentsView, props: true },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/users', name: 'users', component: UsersView },
    { path: '/providers', name: 'providers', component: ProvidersView },
    { path: '/login', name: 'login', component: AuthView },
    { path: '/setup', name: 'setup', component: AuthView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
