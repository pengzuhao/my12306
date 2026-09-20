import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../store/auth';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
  {
    path: '/',
    component: () => import('../views/LayoutView.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
      { path: 'orders', name: 'orders', component: () => import('../views/OrdersView.vue') },
      { path: 'plans', name: 'plans', component: () => import('../views/PlansView.vue') },
      { path: 'session', name: 'session', component: () => import('../views/SessionView.vue') },
      { path: 'feishu', name: 'feishu', component: () => import('../views/FeishuView.vue') },
      { path: 'tasks', name: 'tasks', component: () => import('../views/TasksView.vue') },
      { path: 'users', name: 'users', component: () => import('../views/UsersView.vue') },
    ],
  },
];

export const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.name !== 'login' && !auth.token) return { name: 'login' };
  if (to.name === 'login' && auth.token) return { name: 'dashboard' };
});
