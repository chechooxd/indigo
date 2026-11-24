/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

/**
 * Pins `MIXED_NOTES_COLUMNS` to the real pipeline: `.indigo` source → real
 * `parse`+`resolve` (`@indigodb/core`, not mocked; the WASM compiler cannot
 * run under jsdom) → `resolvedToTables`. If the adapter ever stops threading
 * `@note` into `description`, this fails instead of the component test
 * silently rendering a fixture the docs view never receives.
 */

import { describe, expect, it } from 'vitest';
import { parse, resolve } from '@indigodb/core';
import { resolvedToTables } from '../../../lib/schema-adapter';
import { MIXED_NOTES_COLUMNS, MIXED_NOTES_SOURCE } from './fixtures/mixed-notes';

describe('column @note flows through the adapter', () => {
  it('maps each column note to description, and leaves un-noted columns undefined', () => {
    const [table] = resolvedToTables(resolve(parse(MIXED_NOTES_SOURCE)));

    expect(table.columns.map(({ name, description }) => ({ name, description }))).toEqual(
      MIXED_NOTES_COLUMNS,
    );
  });
});
