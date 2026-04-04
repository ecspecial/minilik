import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../ThemeToggle';
import { useTheme } from '../ThemeContext';
import {
  ANCHOR_STORAGE_KEY,
  WORKSPACE_SECTION_IDS,
  type WorkspaceSectionKey,
} from '../workspaceSections';

const TILES: {
  id: WorkspaceSectionKey;
  title: string;
  desc: string;
  accent: string;
}[] = [
  {
    id: 'analysis',
    title: 'ИИ-анализ изделия',
    desc: 'Тип из справочника, сезон, силуэт, детали и материалы по фото',
    accent: 'var(--landing-accent-1)',
  },
  {
    id: 'constructor',
    title: 'ИИ-конструктор',
    desc: 'Описание конструкции, крой, мерки, ТЗ на черновик лекал',
    accent: 'var(--landing-accent-2)',
  },
  {
    id: 'technologist',
    title: 'ИИ-технолог',
    desc: 'Этапы пошива, оборудование, сложные узлы, риски',
    accent: 'var(--landing-accent-3)',
  },
  {
    id: 'purchasing',
    title: 'ИИ-закупщик',
    desc: 'Ткань, фурнитура, расход и отходность',
    accent: 'var(--landing-accent-4)',
  },
  {
    id: 'finance',
    title: 'ИИ-финансист',
    desc: 'Черновик юнит-экономики: WB, Ozon, свой сайт',
    accent: 'var(--landing-accent-5)',
  },
  {
    id: 'marketer',
    title: 'ИИ-маркетолог',
    desc: 'SEO, описание, буллеты, позиционирование и УТП',
    accent: 'var(--landing-accent-6)',
  },
  {
    id: 'photo',
    title: 'ИИ-фото и визуал',
    desc: 'ТЗ на съёмку, ракурсы, инфографика, генерация изображения',
    accent: 'var(--landing-accent-7)',
  },
];

export default function LandingPage() {
  const nav = useNavigate();
  const { theme } = useTheme();
  const token = localStorage.getItem('mvp_token');
  const logoSrc =
    theme === 'dark' ? '/brand-logo-light.png' : '/brand-logo-dark.png';

  useEffect(() => {
    document.title = 'MiniLik — умный ассортимент';
  }, []);

  function goToModule(key: WorkspaceSectionKey) {
    const hash = `#${WORKSPACE_SECTION_IDS[key]}`;
    if (token) {
      nav(`/workspace${hash}`);
      return;
    }
    sessionStorage.setItem(ANCHOR_STORAGE_KEY, hash);
    nav('/login');
  }

  return (
    <div className="landing-page">
      <div className="landing-topbar">
        <ThemeToggle />
        {token ? (
          <button
            type="button"
            className="landing-link-btn"
            onClick={() => nav('/workspace')}
          >
            Кабинет
          </button>
        ) : (
          <button
            type="button"
            className="landing-link-btn"
            onClick={() => nav('/login')}
          >
            Войти
          </button>
        )}
      </div>

      <header className="landing-header">
        <img
          className="landing-logo"
          src={logoSrc}
          alt="MiniLik"
          width={280}
          height={72}
        />
        <p className="landing-tagline">УМНЫЙ АССОРТИМЕНТ</p>
        <p className="landing-lead">
          Выберите блок — откроется кабинет с ИИ-конвейером на нужном этапе.
        </p>
      </header>

      <div className="landing-grid">
        {TILES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="landing-tile"
            style={{ ['--tile-accent' as string]: t.accent }}
            onClick={() => goToModule(t.id)}
          >
            <span className="landing-tile-title">{t.title}</span>
            <span className="landing-tile-desc">{t.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
