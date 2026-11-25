/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * Static assertion (spec: "No query cancellation is introduced"). Query
 * cancellation is explicitly out of scope for this change — this test
 * fails the build the moment anyone adds a cancel button, a cancel route,
 * or a `pg_cancel_backend` call anywhere in the Studio frontend or the CLI
 * backend it talks to, without needing a runtime UI to prove it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Patterns are anchored to *query cancellation* specifically, not to bare
// verbs like "cancel"/"abort"/"stop" — those alone are too generic (e.g.
// `AbortController`/`AbortSignal` are legitimate DOM/fetch APIs unrelated to
// cancelling a running query) and would make this test a nuisance someone
// eventually deletes. Each pattern below targets a concrete shape a real
// cancel-query feature would actually take in this codebase: a UI button, an
// API route, a handler/function name, or a Postgres-side cancellation call.
const FORBIDDEN_PATTERNS = [
  // UI affordance: "Cancel query" / "Stop query" / "Abort query" buttons,
  // in any casing/separator (cancelQuery, cancel-query, cancel_query, ...).
  /cancel[-_ ]?button/i,
  /(cancel|stop|abort)[-_ ]?quer(y|ies)/i,
  /quer(y|ies)[-_ ]?(cancel|stop|abort)/i,
  // API surface: a dedicated cancel/abort/stop route or handler.
  /cancel[-_ ]?route/i,
  /\/api\/query\/(cancel|abort|stop)/i,
  // Postgres-side cancellation primitives (the substantive backend risk).
  /pg_cancel_backend/i,
  /pg_terminate_backend/i,
];

const THIS_FILE = fileURLToPath(import.meta.url);

// THIS_FILE = <repo>/apps/studio/src/features/studio/query/__tests__/no-cancel-affordance.test.ts
const STUDIO_SRC = join(THIS_FILE, '..', '..', '..', '..', '..'); // apps/studio/src
const REPO_ROOT = join(STUDIO_SRC, '..', '..', '..'); // <repo>

const SCAN_ROOTS = [STUDIO_SRC, join(REPO_ROOT, 'packages', 'cli', 'src')];

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        walk(full);
      } else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

describe('no cancel affordance', () => {
  it('has no cancel button, cancel route, or pg_cancel_backend reference in the Studio frontend or CLI backend source', () => {
    const offenders: { file: string; pattern: string }[] = [];

    for (const root of SCAN_ROOTS) {
      for (const file of collectSourceFiles(root)) {
        if (file === THIS_FILE) continue;
        const content = readFileSync(file, 'utf8');
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(content)) {
            offenders.push({ file, pattern: pattern.source });
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
