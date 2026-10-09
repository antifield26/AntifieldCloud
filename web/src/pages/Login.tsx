import { createSignal, Show } from 'solid-js';
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
    <div class="login-view">
      <div class="login-card">
        <div class="login-mark">π</div>
        <h1>AntifieldCloud</h1>
        <label class="field">
          <span>访问口令</span>
          <input
            type="password"
            placeholder="••••••••"
            value={pw()}
            onInput={(e) => setPw(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </label>
        <Show when={err()}>
          <p class="form-err">{err()}</p>
        </Show>
        <button class="btn btn-primary btn-block" onClick={() => void submit()}>
          登录
        </button>
      </div>
    </div>
  );
}
