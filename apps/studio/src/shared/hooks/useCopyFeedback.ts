/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';

export const COPY_FEEDBACK_MS = 1500;

/**
 * Shared clipboard-copy feedback behaviour, extracted verbatim from
 * `DslEditorToolbar.tsx:32-50` so every copy control (ERD toolbar, docs
 * `DdlPanel`) shares one implementation instead of drifting apart.
 *
 * `copy(text)` awaits `navigator.clipboard.writeText(text)`. On success it
 * sets `copied` true and re-arms a timer that reverts it after
 * `COPY_FEEDBACK_MS`. A rejected write (or a synchronous throw, e.g.
 * `clipboard` undefined) is caught silently: no state change, no dialog.
 */
export function useCopyFeedback(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Rejected clipboard write: no state change, no dialog.
    }
  };

  return { copied, copy };
}
