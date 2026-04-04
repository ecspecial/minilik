import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './ThemeContext';
import './styles.css';

(() => {
  const t = localStorage.getItem('mvp_theme');
  document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
