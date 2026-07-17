import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

import AppShell from '../layouts/AppShell.vue';
import { useAuthStore } from '../stores/auth';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue'), meta: { title: '运行概览' } },
      { path: 'sites', name: 'sites', component: () => import('../views/SitesView.vue'), meta: { title: '中转站' } },
      { path: 'sites/new', name: 'site-new', component: () => import('../views/SiteWizardView.vue'), meta: { title: '添加中转站' } },
      { path: 'sites/:id', name: 'site-detail', component: () => import('../views/SiteDetailView.vue'), meta: { title: '站点详情' } },
      { path: 'rates', name: 'rates', component: () => import('../views/RatesView.vue'), meta: { title: '倍率' } },
      { path: 'incidents', name: 'incidents', component: () => import('../views/IncidentsView.vue'), meta: { title: '事件中心' } },
      { path: 'notifications', name: 'notifications', component: () => import('../views/NotificationsView.vue'), meta: { title: '通知管理' } },
      { path: 'maintenance', name: 'maintenance', component: () => import('../views/MaintenanceView.vue'), meta: { title: '维护与静默' } },
      { path: 'system', name: 'system', component: () => import('../views/SystemView.vue'), meta: { title: '系统设置' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.initialize();
  if (!to.meta.public && !auth.signedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && auth.signedIn) return { name: 'dashboard' };
  document.title = `${String(to.meta.title ?? '管理台')} · Relay Monitor`;
  return true;
});
