import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('../views/LayoutView.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
      { path: 'orders', name: 'orders', component: () => import('../views/OrdersView.vue') },
      { path: 'plans', name: 'plans', component: () => import('../views/PlansView.vue') },
      // 「12306 会话」已融合进顶栏，旧书签自动跳转过去
      { path: 'session', redirect: '/dashboard' },
      { path: 'feishu', name: 'feishu', component: () => import('../views/FeishuView.vue') },
      // 「任务与日志」已合并进购票计划详情，旧书签自动跳转过去
      { path: 'tasks', redirect: '/plans' },
    ],
  },
];

export const router = createRouter({ history: createWebHashHistory(), routes });
