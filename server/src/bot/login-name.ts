/** 从 12306 用户信息接口的 JSON 里取出登录名。优先登录账号，没有则用姓名。 */
export function loginNameFromApiText(raw: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw)?.data;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  const user = row.userDTO && typeof row.userDTO === 'object' ? row.userDTO as Record<string, unknown> : null;
  const login = user?.loginUserDTO && typeof user.loginUserDTO === 'object' ? user.loginUserDTO as Record<string, unknown> : null;
  const nested = row.loginUserDTO && typeof row.loginUserDTO === 'object' ? row.loginUserDTO as Record<string, unknown> : null;
  const candidates = [login?.user_name, nested?.user_name, row.user_name, login?.name, nested?.name, row.name, user?.name];
  for (const value of candidates) {
    const name = String(value ?? '').trim();
    if (name && name.length <= 40) return name;
  }
  return null;
}
