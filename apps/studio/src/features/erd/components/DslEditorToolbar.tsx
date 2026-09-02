/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Copy, Check, History, Save } from 'lucide-react';

const HISTORY_DISABLED_TITLE = "Revision history isn't available yet.";
const COPY_FEEDBACK_MS = 1500;
const SCHEMA_NOT_WRITABLE_TITLE = 'Schema persistence is unavailable in this session.';
const NO_CHANGES_TITLE = 'No unsaved changes.';
const SAVE_TITLE = 'Save schema to disk';

interface DslEditorToolbarProps {
  dslCode: string;
  /**
   * `dslCode !== savedSource`, computed by the parent (decision 16). Never
   * recomputed locally — a locally-owned boolean flag would stay `true`
   * after an undo back to the saved text, which would keep Save enabled for
   * a no-op write.
   */
  dirty: boolean;
  /** `false` disables Save with a stated reason, independent of `dirty`. */
  schemaWritable: boolean;
  /** `true` while a save request is in flight. */
  saving: boolean;
  onSave: () => void;
}

export function DslEditorToolbar({ dslCode, dirty, schemaWritable, saving, onSave }: DslEditorToolbarProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(dslCode);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Rejected clipboard write: show nothing, no dialog.
    }
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={handleCopyCode}
        className="p-1.5 hover:bg-zinc-900 rounded-xl text-zinc-500 hover:text-white transition-colors cursor-pointer"
        title={copied ? 'Copied' : 'Copy DSL script'}
        aria-label={copied ? 'Copied' : 'Copy DSL script'}
      >
        {copied ? (
          <span className="flex items-center gap-1 text-emerald-400">
            <Check className="w-4 h-4" />
            <span className="text-[10px] font-semibold">Copied</span>
          </span>
        ) : (
          <Copy className="w-4 h-4" />
        )}
      </button>
      <button
        disabled
        title={HISTORY_DISABLED_TITLE}
        className="p-1.5 hover:bg-zinc-900 rounded-xl text-zinc-500 hover:text-white transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        <History className="w-4 h-4" />
      </button>
      <button
        onClick={onSave}
        disabled={!schemaWritable || !dirty || saving}
        title={!schemaWritable ? SCHEMA_NOT_WRITABLE_TITLE : !dirty ? NO_CHANGES_TITLE : SAVE_TITLE}
        aria-label={saving ? 'Saving' : 'Save'}
        className="p-1.5 hover:bg-zinc-900 rounded-xl text-zinc-500 hover:text-white transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? (
          <span className="flex items-center gap-1">
            <Save className="w-4 h-4 animate-pulse" />
            <span className="text-[10px] font-semibold">Saving</span>
          </span>
        ) : (
          <Save className="w-4 h-4" />
        )}
      </button>
    </div>
  );
}
