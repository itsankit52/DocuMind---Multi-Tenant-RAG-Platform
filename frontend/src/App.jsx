import { lazy, Suspense } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute, PublicOnlyRoute, RequireRole } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { LoginPage, OnboardingPage, RegisterPage } from './pages/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { ChatPage } from './pages/ChatPage';
import { FullPageLoader, LazyLoadBoundary, Spinner } from './components/Feedback';

// Loaded on demand: only invitees open /invite, and only admins reach /settings/members
// (RequireRole renders before the chunk is requested, so other roles never download it).
const InvitePage = lazy(() => import('./pages/InvitePage').then(m => ({ default: m.InvitePage })));
const MembersPage = lazy(() => import('./pages/MembersPage').then(m => ({ default: m.MembersPage })));

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnlyRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      {/* Public: works signed in or out, with or without an organization */}
      <Route path="/invite" element={<LazyLoadBoundary><Suspense fallback={<FullPageLoader label="Loading invitation…" />}><InvitePage /></Suspense></LazyLoadBoundary>} />
      <Route element={<ProtectedRoute requireOrganization={false} />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
          <Route element={<RequireRole roles={['admin']} />}>
            <Route path="/settings/members" element={<LazyLoadBoundary><Suspense fallback={<Spinner label="Loading members…" />}><MembersPage /></Suspense></LazyLoadBoundary>} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

function NotFound() {
  return (
    <div className="page">
      <h1>Page not found</h1>
      <p><Link to="/">Go to the dashboard</Link></p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
