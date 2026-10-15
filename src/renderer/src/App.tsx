import { useState } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import ProvidersPage from './pages/ProvidersPage';
import ModelsPage from './pages/ModelsPage';
import UsagePage from './pages/UsagePage';
import SettingsPage from './pages/SettingsPage';

type Page = 'dashboard' | 'providers' | 'models' | 'usage' | 'settings';

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />

      <main className="flex-1 overflow-y-auto bg-surface-50 p-6">
        {currentPage === 'dashboard' && <Dashboard />}
        {currentPage === 'providers' && <ProvidersPage />}
        {currentPage === 'models' && <ModelsPage />}
        {currentPage === 'usage' && <UsagePage />}
        {currentPage === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
