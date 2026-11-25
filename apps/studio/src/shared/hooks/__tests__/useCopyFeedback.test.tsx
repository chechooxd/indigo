/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useCopyFeedback } from '../useCopyFeedback';

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
  });
}

describe('useCopyFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('success write sets copied true, then false after 1600ms', async () => {
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyFeedback());

    expect(result.current.copied).toBe(false);

    await act(async () => {
      await result.current.copy('x');
    });

    expect(result.current.copied).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(result.current.copied).toBe(false);
  });

  it('re-click re-arms the timer', async () => {
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => {
      await result.current.copy('x');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    await act(async () => {
      await result.current.copy('x');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.copied).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.copied).toBe(false);
  });

  it('unmount clears the pending timer', async () => {
    stubClipboard(() => Promise.resolve());
    const { result, unmount } = renderHook(() => useCopyFeedback());

    await act(async () => {
      await result.current.copy('x');
    });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejected write, or clipboard undefined, never sets copied', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => {
      await expect(result.current.copy('x')).resolves.toBeUndefined();
    });

    expect(result.current.copied).toBe(false);
  });
});
