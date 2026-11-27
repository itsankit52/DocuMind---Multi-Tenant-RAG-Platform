import { lazy, Suspense } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute, PublicOnlyRoute, RequireRole } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { LoginPage, OnboardingPage, RegisterPage } from './pages/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { ChatPage } from './pages/ChatPage';
import { EmptyState, FullPageLoader, LazyLoadBoundary, Spinner } from './components/Feedback';

// Loaded on demand: only invitees open /invite, and only admins reach /settings/members
// (RequireRole renders before the chunk is requested, so other roles never download it).
const InvitePage = lazy(() => import('./pages/InvitePage').then(m => ({ default: m.InvitePage })));
const GoogleCompletePage = lazy(() => import('./pages/GoogleCompletePage').then(m => ({ default: m.GoogleCompletePage })));
const AccountPage = lazy(() => import('./pages/AccountPage').then(m => ({ default: m.AccountPage })));
const LandingPage = lazy(() => import('./pages/LandingPage').then(m => ({ default: m.LandingPage })));
const MembersPage = lazy(() => import('./pages/MembersPage').then(m => ({ default: m.MembersPage })));
const InvitationsPage = lazy(() => import('./pages/InvitationsPage').then(m => ({ default: m.InvitationsPage })));
const DocumentDetailsPage = lazy(() => import('./pages/DocumentDetailsPage').then(m => ({ default: m.DocumentDetailsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnlyRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      {/* Public: works signed in or out, with or without an organization */}
      <Route path="/invite" element={<LazyLoadBoundary><Suspense fallback={<FullPageLoader label="Loading invitation…" />}><InvitePage /></Suspense></LazyLoadBoundary>} />
      {/* Google callback landing page: public (it loads the session the backend just set) */}
      <Route path="/auth/google/complete" element={<LazyLoadBoundary><Suspense fallback={<FullPageLoader label="Completing Google sign-in…" />}><GoogleCompletePage /></Suspense></LazyLoadBoundary>} />
      <Route element={<ProtectedRoute requireOrganization={false} />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/settings/account" element={<LazyLoadBoundary><Suspense fallback={<FullPageLoader label="Loading account…" />}><AccountPage /></Suspense></LazyLoadBoundary>} />
      </Route>
      {/* "/": landing page when signed out, dashboard when signed in */}
      <Route element={<ProtectedRoute signedOutHome={<LazyLoadBoundary><Suspense fallback={<FullPageLoader />}><LandingPage /></Suspense></LazyLoadBoundary>} />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:documentId" element={<LazyLoadBoundary><Suspense fallback={<Spinner label="Loading document…" />}><DocumentDetailsPage /></Suspense></LazyLoadBoundary>} />
          <Route path="/settings" element={<LazyLoadBoundary><Suspense fallback={<Spinner label="Loading settings…" />}><SettingsPage /></Suspense></LazyLoadBoundary>} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
          <Route element={<RequireRole roles={['admin']} />}>
            <Route path="/settings/members" element={<LazyLoadBoundary><Suspense fallback={<Spinner label="Loading members…" />}><MembersPage /></Suspense></LazyLoadBoundary>} />
            <Route path="/settings/invitations" element={<LazyLoadBoundary><Suspense fallback={<Spinner label="Loading invitations…" />}><InvitationsPage /></Suspense></LazyLoadBoundary>} />
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
      <EmptyState icon="search" title="Page not found">
        The page you’re looking for doesn’t exist. <Link to="/">Go to the dashboard</Link>
      </EmptyState>
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
