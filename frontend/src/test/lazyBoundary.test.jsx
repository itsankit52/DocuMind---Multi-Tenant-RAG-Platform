import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LazyLoadBoundary } from '../components/Feedback';

function BrokenChunk() {
  throw new Error('Failed to fetch dynamically imported module: https://app.example/assets/x.js');
}

describe('LazyLoadBoundary', () => {
  it('shows a fixed reload message when a lazy chunk fails, without the error details', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports caught errors
    const { container } = render(<LazyLoadBoundary><BrokenChunk /></LazyLoadBoundary>);
    expect(screen.getByRole('heading', { name: "This page couldn't be loaded" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Failed to fetch|https?:/);
    vi.restoreAllMocks();
  });

  it('renders children normally', () => {
    render(<LazyLoadBoundary><p>Page content</p></LazyLoadBoundary>);
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });
});
