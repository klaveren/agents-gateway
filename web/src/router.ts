import { createRouter, createWebHistory } from 'vue-router'
import AgentsView from './views/AgentsView.vue'
import InboxView from './views/InboxView.vue'
import AuthView from './views/AuthView.vue'
import McpView from './views/McpView.vue'
import PackagesView from './views/PackagesView.vue'
import ProfileView from './views/ProfileView.vue'
import ProvidersView from './views/ProvidersView.vue'
import SettingsView from './views/SettingsView.vue'
import UsageView from './views/UsageView.vue'
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
    // ⚠️ `/settings#conta` era o "Perfil" antes de ele ter página: o link antigo (favorito) cai no lugar certo.
    { path: '/settings', name: 'settings', component: SettingsView, beforeEnter: (to) => (to.hash === '#conta' ? { path: '/profile', replace: true } : true) },
    { path: '/profile', name: 'profile', component: ProfileView },
    { path: '/users', name: 'users', component: UsersView },
    { path: '/users/new', name: 'user-new', component: UsersView },
    { path: '/users/:id', name: 'user', component: UsersView, props: true },
    { path: '/usage', name: 'usage', component: UsageView },
    { path: '/mcp', name: 'mcp', component: McpView },
    { path: '/packages', name: 'packages', component: PackagesView },
    { path: '/mcp/new', name: 'mcp-new', component: McpView },
    { path: '/mcp/:id', name: 'mcp-server', component: McpView, props: true },
    { path: '/providers', name: 'providers', component: ProvidersView },
    { path: '/providers/new', name: 'provider-new', component: ProvidersView },
    { path: '/providers/:id', name: 'provider', component: ProvidersView, props: true },
    { path: '/login', name: 'login', component: AuthView },
    { path: '/setup', name: 'setup', component: AuthView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
