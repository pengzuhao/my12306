import { ElMessage } from 'element-plus';
import LoginView from '../views/LoginView.vue';
import LayoutView from '../views/LayoutView.vue';
import DashboardView from '../views/DashboardView.vue';
import OrdersView from '../views/OrdersView.vue';
import TrainsView from '../views/TrainsView.vue';
import PlansView from '../views/PlansView.vue';
import NotificationsView from '../views/NotificationsView.vue';
import LogsView from '../views/LogsView.vue';
import AdminView from '../views/AdminView.vue';
import { initAuth, appUser, multiUser } from '../store/auth';
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/login', component: LoginView },
  {
    path: '/',
    component: LayoutView,
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: DashboardView },
      { path: 'orders', name: 'orders', component: OrdersView },
      { path: 'trains', name: 'trains', component: TrainsView },
      { path: 'plans', name: 'plans', component: PlansView },
      // 「12306 会话」已融合进顶栏，旧书签自动跳转过去
      { path: 'session', redirect: '/dashboard' },
      { path: 'feishu', redirect: '/notifications' },
      { path: 'notifications', component: NotificationsView },
      { path: 'logs', component: LogsView },
      { path: 'admin', component: AdminView },
      // 「任务与日志」已合并进购票计划详情，旧书签自动跳转过去
      { path: 'tasks', redirect: '/plans' },
    ],
  },
];

export const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach(async to => {
  await initAuth();
  if (multiUser.value && !appUser.value && to.path !== '/login') return '/login';
  if ((!multiUser.value || appUser.value) && to.path === '/login') return '/dashboard';
  if (to.path === '/admin' && (!multiUser.value || appUser.value?.role !== 'admin')) return '/dashboard';
});

router.onError(() => { ElMessage.error('页面打开失败，请稍后再试；若服务已关闭，请先启动服务'); });
