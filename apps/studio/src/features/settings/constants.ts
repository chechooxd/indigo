/**
 * @license
 * SPDX-License-Identifier: MIT
 */

export interface ThemeAccentOption {
  id: string;
  bg: string;
}

export const THEME_ACCENTS: ThemeAccentOption[] = [
  { id: 'indigo', bg: 'bg-indigo-500' },
  { id: 'emerald', bg: 'bg-emerald-500' },
  { id: 'rose', bg: 'bg-rose-500' },
  { id: 'amber', bg: 'bg-amber-500' },
];
