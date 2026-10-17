import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import ProvidersPage from './pages/ProvidersPage';
import ModelsPage from './pages/ModelsPage';
import UsagePage from './pages/UsagePage';
import AuditPage from './pages/AuditPage';
import ProfilesPage from './pages/ProfilesPage';
import SettingsPage from './pages/SettingsPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { pageFromPath, pathForPage } from './lib/routes';

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPage = pageFromPath(location.pathname);

  // An unknown screen name must not silently render the dashboard behind its own URL.
  useEffect(() => {
    const canonical = pathForPage(currentPage);
    if (location.pathname !== canonical) {
      navigate(canonical, { replace: true });
    }
  }, [currentPage, location.pathname, navigate]);

  return (
    <div className="flex h-screen overflow-hidden bg-surface-50/50">
      <Sidebar
        currentPage={currentPage}
        onNavigate={(page) => navigate(pathForPage(page))}
      />

      <main className="flex-1 min-w-0 overflow-y-auto p-6 2xl:p-8">
        <ErrorBoundary
          resetKey={currentPage}
          fallback={
            <div className="text-center py-12 text-surface-500">
              页面加载出错，切换到其他页面即可重试
            </div>
          }
        >
          {currentPage === 'dashboard' && <Dashboard />}
          {currentPage === 'providers' && <ProvidersPage />}
          {currentPage === 'models' && <ModelsPage />}
          {currentPage === 'usage' && <UsagePage />}
          {currentPage === 'audit' && <AuditPage />}
          {currentPage === 'profiles' && <ProfilesPage />}
          {currentPage === 'settings' && <SettingsPage />}
        </ErrorBoundary>
      </main>
    </div>
  );
}
