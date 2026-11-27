import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext';
import { AppRoutes } from '../App';
import { authApi } from './apiMock';
import { mockSignedIn, renderApp, resetApiMocks, unauthorized } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));

beforeEach(() => { resetApiMocks(); });
const signedOut = () => authApi.me.mockRejectedValue(unauthorized());

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname}</output>;
}

describe('Landing page', () => {
  it('is shown at "/" to signed-out visitors with all sections', async () => {
    signedOut();
    const { container } = renderApp('/');
    // first test pays the one-time lazy import of the landing chunk
    expect(await screen.findByRole('heading', { level: 1, name: 'Your organization’s knowledge, finally searchable.' }, { timeout: 5000 })).toBeInTheDocument();
    for (const name of ['Answers backed by your documents.', 'Built around the way teams use documents.',
      'From documents to useful answers.', 'Built for organizational knowledge.', 'Make your organization’s knowledge easier to access.']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    for (const name of ['Document Intelligence', 'Context-Aware Answers', 'Multi-Tenant Isolation', 'Role-Based Access',
      'Create your organization.', 'Upload your documents.', 'Process and index content.', 'Ask questions and explore cited answers.']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    expect(screen.getByRole('contentinfo')).toHaveTextContent(`© ${new Date().getFullYear()} DocuMind`);

    // product previews are the app's own UI (chat, citations, status badges), static and out of the tab order
    const previews = container.querySelectorAll('.lp-app');
    expect(previews.length).toBe(3);
    for (const p of previews) { expect(p).toHaveAttribute('inert'); expect(p).toHaveAttribute('aria-hidden', 'true'); }
    expect([...container.querySelectorAll('.lp-app .citations')].map(c => c.textContent).join(' ')).toContain('Records Retention Policy.docx');
    expect(container.querySelectorAll('.lp-app [data-testid="doc-status"]').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/sample/i).length).toBeGreaterThan(0); // sample content is labelled
  });

  it('nav anchors point at existing sections; account links use existing routes', async () => {
    signedOut();
    const { container } = renderApp('/');
    const nav = within(await screen.findByRole('navigation', { name: 'Main' }));
    expect(nav.queryByRole('link', { name: /Documentation/ })).toBeNull(); // no docs page exists
    for (const [name, id] of [['Product', 'product'], ['How It Works', 'how-it-works'], ['Security', 'security']]) {
      expect(nav.getByRole('link', { name })).toHaveAttribute('href', `#${id}`);
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(nav.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(nav.getByRole('link', { name: 'Get Started' })).toHaveAttribute('href', '/register');
    for (const link of screen.getAllByRole('link', { name: /^Get Started$/ })) expect(link).toHaveAttribute('href', '/register');
    expect(screen.getByRole('link', { name: 'Explore the product' })).toHaveAttribute('href', '#product');
    for (const a of container.querySelectorAll('a[href^="#"]')) expect(container.querySelector(a.getAttribute('href'))).not.toBeNull();
    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByRole('link', { name: 'Security' })).toHaveAttribute('href', '#security');
    expect(footer.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
    expect(footer.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
  });

  it('Get Started opens the registration page and Login the sign-in page', async () => {
    signedOut();
    render(<MemoryRouter initialEntries={['/']}><AuthProvider><AppRoutes /><LocationProbe /></AuthProvider></MemoryRouter>);
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Get Started' }));
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/register');
  });

  it('mobile menu toggles with accessible state and closes on Escape', async () => {
    signedOut();
    renderApp('/');
    const user = userEvent.setup();
    const toggle = await screen.findByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('landing-mobile-menu')).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(document.getElementById('landing-mobile-menu')).toBeNull();
  });

  it('signed-in users still get the dashboard at "/"; other protected paths still redirect to login', async () => {
    mockSignedIn();
    const { unmount } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByText('Your organization’s knowledge, finally searchable.')).not.toBeInTheDocument();
    unmount();
    resetApiMocks();
    signedOut();
    renderApp('/documents');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
