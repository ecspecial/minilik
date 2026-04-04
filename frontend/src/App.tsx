import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import WorkspacePage from './pages/WorkspacePage';

export default function App() {
  /* Без подписки на location App не перерисовывается после navigate('/');
   * остаётся старый element={<Navigate to="/workspace" />} → мигание / пустой экран. */
  useLocation();

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/workspace" element={<WorkspacePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
