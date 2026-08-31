/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EnvironmentBadge } from '../EnvironmentBadge';
import { useAuthStore } from '../../../store/useAuthStore';

describe('EnvironmentBadge', () => {
  beforeEach(() => {
    useAuthStore.setState({ environment: null });
  });

  it('renders nothing when environment is null', () => {
    useAuthStore.setState({ environment: null });
    const { container } = render(<EnvironmentBadge />);

    expect(screen.queryByTestId('environment-badge')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders "production" verbatim with the production tone class, distinct from staging/development', () => {
    useAuthStore.setState({ environment: 'production' });
    render(<EnvironmentBadge />);

    const badge = screen.getByTestId('environment-badge');
    expect(badge).toHaveTextContent('production');
    expect(badge.className).toContain('rose');
  });

  it('renders "staging" verbatim with the staging tone class, distinct from production', () => {
    useAuthStore.setState({ environment: 'staging' });
    render(<EnvironmentBadge />);

    const badge = screen.getByTestId('environment-badge');
    expect(badge).toHaveTextContent('staging');
    expect(badge.className).toContain('amber');
    expect(badge.className).not.toContain('rose');
  });

  it('renders "development" verbatim with the development tone class, distinct from production/staging', () => {
    useAuthStore.setState({ environment: 'development' });
    render(<EnvironmentBadge />);

    const badge = screen.getByTestId('environment-badge');
    expect(badge).toHaveTextContent('development');
    expect(badge.className).toContain('zinc');
    expect(badge.className).not.toContain('rose');
    expect(badge.className).not.toContain('amber');
  });

  it('renders an unrecognised but valid label ("qa") verbatim with the shared neutral tone', () => {
    useAuthStore.setState({ environment: 'qa' });
    render(<EnvironmentBadge />);

    const badge = screen.getByTestId('environment-badge');
    expect(badge).toHaveTextContent('qa');
    expect(badge.className).not.toContain('rose');
    expect(badge.className).not.toContain('amber');
  });

  it('recognises "Production" case-insensitively, renders it verbatim, and applies the production tone', () => {
    useAuthStore.setState({ environment: 'Production' });
    render(<EnvironmentBadge />);

    const badge = screen.getByTestId('environment-badge');
    expect(badge).toHaveTextContent('Production');
    expect(badge.className).toContain('rose');
  });

  it('truncates a maximum-length label with a static class and carries the full value in title; never uses role="status"', () => {
    const longLabel = 'a'.repeat(32);
    useAuthStore.setState({ environment: longLabel });
    render(<EnvironmentBadge />);

    const badge = screen.getByTestId('environment-badge');
    expect(badge.className).toContain('truncate');
    expect(badge).toHaveAttribute('title', longLabel);
    expect(badge).not.toHaveAttribute('role', 'status');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('carries an aria-label sourced from the i18n key (raw key in this test env)', () => {
    useAuthStore.setState({ environment: 'production' });
    render(<EnvironmentBadge />);

    const badge = screen.getByTestId('environment-badge');
    expect(badge).toHaveAttribute('aria-label', 'environment.badge_aria');
  });
});
