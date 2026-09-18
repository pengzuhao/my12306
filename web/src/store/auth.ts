import { defineStore } from 'pinia';
import { authApi } from '../api';

interface User {
  id: string;
  username: string;
  role: string;
  displayName: string;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('my12306_token') || '',
    user: null as User | null,
  }),
  actions: {
    async login(username: string, password: string): Promise<void> {
      const res = await authApi.login(username, password);
      this.token = res.token;
      this.user = res.user;
      localStorage.setItem('my12306_token', res.token);
    },
    async loadMe(): Promise<void> {
      try {
        this.user = await authApi.me();
      } catch {
        this.logout();
      }
    },
    logout(): void {
      this.token = '';
      this.user = null;
      localStorage.removeItem('my12306_token');
    },
  },
});
