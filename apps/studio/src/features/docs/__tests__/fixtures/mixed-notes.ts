/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A table mixing documented and undocumented columns. `MIXED_NOTES_COLUMNS`
 * is pinned to what the REAL pipeline (`parse` → `resolve` →
 * `resolvedToTables`) yields for `MIXED_NOTES_SOURCE` — see
 * `column-notes.pipeline.test.ts` — so the component test renders the exact
 * shape the docs view receives, not a hand-guessed one.
 */
export const MIXED_NOTES_SOURCE = `
Table Account {
  id        Int       @id @default(autoincrement()) @note("Unique identifier")
  email     String
  deletedAt DateTime? @note("Soft-delete timestamp")
}
`;

export const MIXED_NOTES_COLUMNS: { name: string; description: string | undefined }[] = [
  { name: 'id', description: 'Unique identifier' },
  { name: 'email', description: undefined },
  { name: 'deletedAt', description: 'Soft-delete timestamp' },
];
