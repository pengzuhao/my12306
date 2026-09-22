import { ref } from 'vue';
import { http } from '../api';
export interface AppUser { id: string; username: string; displayName: string; role: 'admin' | 'user'; disabled?: boolean }
export const multiUser = ref(false);
export const appUser = ref<AppUser | null>(null);
let initialized: Promise<void> | null = null;
export function initAuth(): Promise<void> {
  return initialized ??= (async () => {
    multiUser.value = (await http.get('/auth/mode')).data.multiUser;
    try { appUser.value = (await http.get('/auth/me')).data; }
    catch (e) { if ((e as { response?: { status: number } }).response?.status !== 401) throw e; }
  })().catch(e => { initialized = null; throw e; });
}
export async function logoutApp(): Promise<void> {
  try { await http.post('/auth/logout'); }
  catch (e) { if ((e as { response?: { status: number } }).response?.status !== 401) throw e; }
  clearAppLogin();
}
export function clearAppLogin(): void {
  appUser.value = null;
  sessionStorage.removeItem('my12306_guide_dismissed');
  location.hash = '#/login'; location.reload();
}
