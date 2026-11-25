/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import type { ViewTab } from '../../types';

/** i18n key for the header's title suffix, per active tab. */
export const TAB_TITLE_KEYS: Record<ViewTab, string> = {
  home: 'sidebar.dashboard',
  studio: 'sidebar.studio',
  editor: 'sidebar.architecture',
  docs: 'sidebar.documentation',
  settings: 'sidebar.settings',
};
