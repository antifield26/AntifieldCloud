import { createSignal } from 'solid-js';
import { api } from '../api';

export default function Login(props: { onOk: () => void }) {
  const [pw, setPw] = createSignal('');
  const [err, setErr] = createSignal('');
  const submit = async (): Promise<void> => {
    setErr('');
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: pw() }) });
      props.onOk();
    } catch {
      setErr('密码错误');
    }
  };
  return (
    <div class="min-h-screen flex items-center justify-center bg-gray-900">
      <div class="bg-white rounded p-6 w-80 space-y-3">
        <h1 class="font-bold text-lg">AntifieldCloud 登录</h1>
        <input
          type="password"
          class="w-full border rounded px-2 py-1"
          placeholder="密码"
          value={pw()}
          onInput={(e) => setPw(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        {err() && <div class="text-red-700 text-sm">{err()}</div>}
        <button class="w-full bg-blue-600 text-white py-1 rounded" onClick={() => void submit()}>
          登录
        </button>
      </div>
    </div>
  );
}
