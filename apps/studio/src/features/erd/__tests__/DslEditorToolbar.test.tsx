/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { DslEditorToolbar } from '../components/DslEditorToolbar';

describe('DslEditorToolbar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('honestly disables History with a stated reason and never calls alert', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    render(<DslEditorToolbar dslCode="model Foo {}" />);

    const historyButton = screen.getByTitle("Revision history isn't available yet.");
    expect(historyButton).toBeDisabled();

    act(() => {
      historyButton.click();
    });

    expect(alertSpy).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('copies the DSL code and shows a transient inline "Copied" state that reverts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<DslEditorToolbar dslCode="model Foo {}" />);

    const copyButton = screen.getByRole('button', { name: /copy/i });

    await act(async () => {
      copyButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('model Foo {}');
    expect(screen.getByText(/copied/i)).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(screen.queryByText(/copied/i)).not.toBeInTheDocument();

    alertSpy.mockRestore();
  });
});
