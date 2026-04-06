import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, setAuthToken } from '../api';
import { ThemeToggle } from '../ThemeToggle';
import { ANCHOR_STORAGE_KEY } from '../workspaceSections';

export default function LoginPage() {
  const nav = useNavigate();
  const [username, setUsername] = useState('');

  useEffect(() => {
    document.title = 'MiniLik — вход';
  }, []);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const { accessToken } = await login(username, password);
      localStorage.setItem('mvp_token', accessToken);
      setAuthToken(accessToken);
      const raw = sessionStorage.getItem(ANCHOR_STORAGE_KEY);
      sessionStorage.removeItem(ANCHOR_STORAGE_KEY);
      const hash =
        raw && raw.startsWith('#')
          ? raw
          : raw
            ? `#${raw}`
            : '';
      nav(`/workspace${hash}`, { replace: true });
    } catch {
      setErr(
        'Не удалось войти. Проверьте логин и пароль или попробуйте позже.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap" style={{ position: 'relative' }}>
      <div className="login-topbar">
        <ThemeToggle />
      </div>
      <div className="login-card">
        <h1 className="brand-title">Вход</h1>
        <form className="login-form" onSubmit={onSubmit}>
          <div className="login-field">
            <label htmlFor="login-username">Логин</label>
            <input
              id="login-username"
              className="login-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div className="login-field">
            <label htmlFor="login-password">Пароль</label>
            <input
              id="login-password"
              className="login-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          {err && <p className="err login-err">{err}</p>}
          <button
            type="submit"
            className="login-submit"
            disabled={loading}
          >
            {loading ? 'Вход…' : 'Войти в кабинет'}
          </button>
        </form>
      </div>
    </div>
  );
}
