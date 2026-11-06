// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '@/components/layout/Sidebar';

const mockSignOut = vi.fn();
const mockSetTheme = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: {
        name: 'Test Author',
        email: 'author@novelforge.test',
      },
    },
  }),
  signOut: (options: unknown) => mockSignOut(options),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: 'dark',
    setTheme: mockSetTheme,
  }),
}));

vi.mock('@/components/generation/GenerationContext', () => ({
  useOptionalGeneration: () => null,
}));

describe('Sidebar micro-UX and accessibility', () => {
  it('renders sign out button with accessible label and triggers sign out on click', () => {
    render(<Sidebar />);

    const signOutBtn = screen.getByRole('button', { name: /sign out/i });
    expect(signOutBtn).toBeInTheDocument();
    expect(signOutBtn).toHaveAttribute('type', 'button');
    expect(signOutBtn).toHaveAttribute('aria-label', 'Sign out');

    fireEvent.click(signOutBtn);
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: '/' });
  });

  it('renders theme switch button as a button and switches theme on click', () => {
    render(<Sidebar />);

    const themeBtn = screen.getByRole('button', { name: /light mode/i });
    expect(themeBtn).toBeInTheDocument();
    expect(themeBtn).toHaveAttribute('type', 'button');

    fireEvent.click(themeBtn);
    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });
});
