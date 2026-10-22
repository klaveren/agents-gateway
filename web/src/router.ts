import { createRouter, createWebHistory } from 'vue-router'
import AgentsView from './views/AgentsView.vue'
import InboxView from './views/InboxView.vue'
import SettingsView from './views/SettingsView.vue'

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
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
