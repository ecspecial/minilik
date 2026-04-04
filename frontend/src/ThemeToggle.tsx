import { useTheme } from './ThemeContext';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="theme-switch" role="group" aria-label="Тема оформления">
      <button
        type="button"
        className={`theme-switch-btn ${theme === 'light' ? 'on' : ''}`}
        onClick={() => setTheme('light')}
      >
        Светлая
      </button>
      <button
        type="button"
        className={`theme-switch-btn ${theme === 'dark' ? 'on' : ''}`}
        onClick={() => setTheme('dark')}
      >
        Тёмная
      </button>
    </div>
  );
}
