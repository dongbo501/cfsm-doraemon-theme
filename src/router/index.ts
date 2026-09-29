import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * CFSM 主题路由约定：首页 /#/，详情页 /#/server/:id；管理后台由内置默认主题接管（/admin#admin）
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
    },
    {
      path: '/server/:id',
      name: 'instance-detail',
      component: () => import('@/views/InstanceDetail.vue'),
    },
    {
      path: '/theme-settings',
      name: 'theme-settings',
      component: () => import('@/views/ThemeSettings.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
})

export default router
