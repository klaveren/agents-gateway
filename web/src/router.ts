import { createRouter, createWebHistory } from 'vue-router'
import AgentsView from './views/AgentsView.vue'
import InboxView from './views/InboxView.vue'
import AuthView from './views/AuthView.vue'
import McpView from './views/McpView.vue'
import PackagesView from './views/PackagesView.vue'
import ProfileView from './views/ProfileView.vue'
import DocsView from './views/DocsView.vue'
import ProjectsView from './views/ProjectsView.vue'
import RulesView from './views/RulesView.vue'
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
    { path: '/projects', name: 'projects', component: ProjectsView },
    { path: '/projects/new', name: 'project-new', component: ProjectsView },
    { path: '/projects/:id', name: 'project', component: ProjectsView, props: true },
    { path: '/rules', name: 'rules', component: RulesView },
    { path: '/docs', name: 'docs', component: DocsView },
    { path: '/docs/new', name: 'doc-new', component: DocsView },
    { path: '/docs/:id', name: 'doc', component: DocsView, props: true },
    { path: '/mcp/new', name: 'mcp-new', component: McpView },
    { path: '/mcp/:id', name: 'mcp-server', component: McpView, props: true },
    // A página chama "Modelos" (o termo que todo mundo conhece); `/providers` era o endereço antigo e redireciona.
    { path: '/models', name: 'providers', component: ProvidersView },
    { path: '/models/new', name: 'provider-new', component: ProvidersView },
    { path: '/models/:id', name: 'provider', component: ProvidersView, props: true },
    { path: '/providers/:rest(.*)*', redirect: (to) => ({ path: `/models${to.path.slice('/providers'.length)}`, query: to.query }) },
    { path: '/login', name: 'login', component: AuthView },
    { path: '/setup', name: 'setup', component: AuthView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
