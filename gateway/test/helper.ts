// 测试 helper：读密封初始口令并登录，返回 Cookie 头。
import { readFileSync } from 'node:fs';

export function sealedPw(): string {
  const lines = readFileSync(process.env.WB_INITIAL_PW_FILE as string, 'utf8').trim().split('\n');
  return lines[lines.length - 1];
}

export async function loginCookie(app: { inject(o: unknown): Promise<{ headers: Record<string, unknown>; statusCode: number }> }): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: JSON.stringify({ password: sealedPw() }),
    headers: { 'content-type': 'application/json' },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`);
  const set = res.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : String(set);
  return String(first).split(';')[0];
}
