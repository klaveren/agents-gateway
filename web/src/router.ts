import { createRouter, createWebHistory } from 'vue-router'
import AgentsView from './views/AgentsView.vue'
import InboxView from './views/InboxView.vue'
import AuthView from './views/AuthView.vue'
import McpView from './views/McpView.vue'
import PackagesView from './views/PackagesView.vue'
import ProfileView from './views/ProfileView.vue'
import DocsView from './views/DocsView.vue'
import ProjectsView from './views/ProjectsView.vue'
import ResourcesView from './views/ResourcesView.vue'
import BuildView from './views/BuildView.vue'
import RulesView from './views/RulesView.vue'
import EnvironmentView from './views/EnvironmentView.vue'
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
    { path: '/agents/build', name: 'agent-build', component: BuildView, props: { kind: 'agent', tab: 'build' } },
    { path: '/agents/protocol', name: 'agent-protocol', component: BuildView, props: { kind: 'agent', tab: 'protocol' } },
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
    { path: '/rules/build', name: 'rule-build', component: BuildView, props: { kind: 'rule', tab: 'build' } },
    { path: '/rules/protocol', name: 'rule-protocol', component: BuildView, props: { kind: 'rule', tab: 'protocol' } },
    { path: '/environment', name: 'environment', component: EnvironmentView },
    { path: '/specs', name: 'specs', component: DocsView, props: { kind: 'spec' } },
    { path: '/specs/new', name: 'spec-new', component: DocsView, props: { kind: 'spec' } },
    { path: '/specs/build', name: 'spec-build', component: BuildView, props: { kind: 'spec', tab: 'build' } },
    { path: '/specs/protocol', name: 'spec-protocol', component: BuildView, props: { kind: 'spec', tab: 'protocol' } },
    { path: '/specs/:id', name: 'spec', component: DocsView, props: (to) => ({ kind: 'spec', id: to.params.id }) },
    { path: '/adrs', name: 'adrs', component: DocsView, props: { kind: 'adr' } },
    { path: '/adrs/new', name: 'adr-new', component: DocsView, props: { kind: 'adr' } },
    { path: '/adrs/build', name: 'adr-build', component: BuildView, props: { kind: 'adr', tab: 'build' } },
    { path: '/adrs/protocol', name: 'adr-protocol', component: BuildView, props: { kind: 'adr', tab: 'protocol' } },
    { path: '/adrs/:id', name: 'adr', component: DocsView, props: (to) => ({ kind: 'adr', id: to.params.id }) },
    { path: '/knowledge', name: 'knowledges', component: DocsView, props: { kind: 'knowledge' } },
    { path: '/knowledge/new', name: 'knowledge-new', component: DocsView, props: { kind: 'knowledge' } },
    { path: '/knowledge/build', name: 'knowledge-build', component: BuildView, props: { kind: 'knowledge', tab: 'build' } },
    { path: '/knowledge/protocol', name: 'knowledge-protocol', component: BuildView, props: { kind: 'knowledge', tab: 'protocol' } },
    { path: '/knowledge/:id', name: 'knowledge', component: DocsView, props: (to) => ({ kind: 'knowledge', id: to.params.id }) },
    { path: '/docs', redirect: '/specs' },
    { path: '/skills', name: 'skills', component: ResourcesView, props: { kind: 'skill' } },
    { path: '/skills/new', name: 'skill-new', component: ResourcesView, props: { kind: 'skill' } },
    { path: '/skills/build', name: 'skill-build', component: BuildView, props: { kind: 'skill', tab: 'build' } },
    { path: '/skills/protocol', name: 'skill-protocol', component: BuildView, props: { kind: 'skill', tab: 'protocol' } },
    { path: '/skills/:id', name: 'skill', component: ResourcesView, props: (to) => ({ kind: 'skill', id: to.params.id }) },
    { path: '/commands', name: 'commands', component: ResourcesView, props: { kind: 'command' } },
    { path: '/commands/new', name: 'command-new', component: ResourcesView, props: { kind: 'command' } },
    { path: '/commands/build', name: 'command-build', component: BuildView, props: { kind: 'command', tab: 'build' } },
    { path: '/commands/protocol', name: 'command-protocol', component: BuildView, props: { kind: 'command', tab: 'protocol' } },
    { path: '/commands/:id', name: 'command', component: ResourcesView, props: (to) => ({ kind: 'command', id: to.params.id }) },
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
