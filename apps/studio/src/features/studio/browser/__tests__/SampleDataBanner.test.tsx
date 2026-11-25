/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SampleDataBanner } from '../components/SampleDataBanner';

vi.mock('../../../../lib/api', () => ({
  isBackendAvailable: vi.fn(() => false),
}));

import { isBackendAvailable } from '../../../../lib/api';

describe('SampleDataBanner', () => {
  beforeEach(() => {
    vi.mocked(isBackendAvailable).mockReset();
  });

  it('renders a status banner announcing sample data when there is no backend', () => {
    vi.mocked(isBackendAvailable).mockReturnValue(false);
    render(<SampleDataBanner />);

    const banner = screen.getByRole('status');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/sample/i);
  });

  it('renders nothing when connected to a real backend', () => {
    vi.mocked(isBackendAvailable).mockReturnValue(true);
    const { container } = render(<SampleDataBanner />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
