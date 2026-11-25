/**
 * @license
 * SPDX-License-Identifier: MIT
 */

const KEYWORDS = ['select', 'from', 'where', 'limit', 'order by', 'group by', 'left join', 'inner join', 'on'];

/** Collapses whitespace and uppercases SQL keywords for readability. */
export function formatSql(sql: string): string {
  let clean = sql.replace(/\s+/g, ' ').trim();
  KEYWORDS.forEach((keyword) => {
    const reg = new RegExp(`\\b${keyword}\\b`, 'gi');
    clean = clean.replace(reg, keyword.toUpperCase());
  });
  return clean;
}
