// 测试 helper：用环境口令登录，返回 Cookie 头。
export async function loginCookie(app: { inject(o: unknown): Promise<{ headers: Record<string, unknown>; statusCode: number }> }): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: JSON.stringify({ password: process.env.AUTH_LOGIN_PASSWORD ?? '' }),
    headers: { 'content-type': 'application/json' },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`);
  const set = res.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : String(set);
  return String(first).split(';')[0];
}
