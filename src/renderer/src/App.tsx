import { useState } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import ProvidersPage from './pages/ProvidersPage';
import ModelsPage from './pages/ModelsPage';
import UsagePage from './pages/UsagePage';
import SettingsPage from './pages/SettingsPage';
import { ErrorBoundary } from './components/ErrorBoundary';

type Page = 'dashboard' | 'providers' | 'models' | 'usage' | 'settings';

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');

  return (
    <div className="flex h-screen overflow-hidden bg-surface-50/50">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />

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
          {currentPage === 'settings' && <SettingsPage />}
        </ErrorBoundary>
      </main>
    </div>
  );
}
