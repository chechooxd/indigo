/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { Radio } from 'lucide-react';
import type { LiveStatus } from '@indigodb/client/realtime';

const STATUS_LABEL: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  error: 'Live (reconnecting…)',
};

const STATUS_DOT_CLASS: Record<LiveStatus, string> = {
  connecting: 'bg-zinc-500 animate-pulse',
  live: 'bg-emerald-400',
  error: 'bg-amber-400 animate-pulse',
};

/**
 * Renders only for a non-`null` status — `studio-ui-honesty` is encoded in
 * `useLiveTable`'s return type (`null` ⇒ inert), not in a JSX `disabled`
 * conditional here. `error` is transient/auto-recovering (design decision
 * 6), so it never renders as a hard failure — just a reconnecting label.
 */
export function LiveStatusBadge({ status }: { status: LiveStatus | null }) {
  if (status === null) return null;

  return (
    <span
      className="flex items-center gap-1.5 text-zinc-400 px-2.5 py-1 rounded-xl text-xs font-mono"
      title={`Live view: ${STATUS_LABEL[status]}`}
    >
      <Radio className="w-3 h-3" />
      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT_CLASS[status]}`} />
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}
