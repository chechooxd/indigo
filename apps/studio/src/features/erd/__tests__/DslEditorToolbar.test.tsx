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

    render(
      <DslEditorToolbar
        dslCode="model Foo {}"
        dirty={false}
        schemaWritable={true}
        saving={false}
        onSave={() => {}}
      />,
    );

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

    render(
      <DslEditorToolbar
        dslCode="model Foo {}"
        dirty={false}
        schemaWritable={true}
        saving={false}
        onSave={() => {}}
      />,
    );

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

  describe('Save button', () => {
    it('SD-4: renders disabled with a stated reason when schemaWritable is false', () => {
      render(
        <DslEditorToolbar
          dslCode="model Foo {}"
          dirty={true}
          schemaWritable={false}
          saving={false}
          onSave={() => {}}
        />,
      );

      const saveButton = screen.getByRole('button', { name: /save/i });
      expect(saveButton).toBeDisabled();
      expect(saveButton.title).toMatch(/unavailable|not writable|no schema file/i);
    });

    it('stays disabled when writable but not dirty (nothing to save)', () => {
      render(
        <DslEditorToolbar
          dslCode="model Foo {}"
          dirty={false}
          schemaWritable={true}
          saving={false}
          onSave={() => {}}
        />,
      );

      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    });

    it('is enabled once writable and dirty', () => {
      render(
        <DslEditorToolbar
          dslCode="model Foo {}"
          dirty={true}
          schemaWritable={true}
          saving={false}
          onSave={() => {}}
        />,
      );

      expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
    });

    it('calls onSave when clicked while enabled', () => {
      const onSave = vi.fn();
      render(
        <DslEditorToolbar
          dslCode="model Foo {}"
          dirty={true}
          schemaWritable={true}
          saving={false}
          onSave={onSave}
        />,
      );

      act(() => {
        screen.getByRole('button', { name: /save/i }).click();
      });

      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('disables the button and reflects the saving state while a save is in flight', () => {
      render(
        <DslEditorToolbar
          dslCode="model Foo {}"
          dirty={true}
          schemaWritable={true}
          saving={true}
          onSave={() => {}}
        />,
      );

      expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    });
  });
});
