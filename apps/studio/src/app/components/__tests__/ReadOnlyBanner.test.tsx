/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ReadOnlyBanner } from '../ReadOnlyBanner';
import { useAuthStore } from '../../../store/useAuthStore';

describe('ReadOnlyBanner', () => {
  beforeEach(() => {
    useAuthStore.setState({ readOnly: false });
  });

  it('renders a status banner announcing read-only mode when the store reports readOnly:true', () => {
    useAuthStore.setState({ readOnly: true });
    render(<ReadOnlyBanner />);

    const banner = screen.getByRole('status');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('readOnly.banner');
  });

  it('renders nothing when the store reports readOnly:false', () => {
    useAuthStore.setState({ readOnly: false });
    const { container } = render(<ReadOnlyBanner />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
