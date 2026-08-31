/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../../store/useDataStore', () => ({
  useDataStore: () => ({
    tables: [{ name: 'users', schema: 'public', columns: [], records: [] }],
    setTables: vi.fn(),
    setResolvedSchema: vi.fn(),
  }),
}));

vi.mock('../../../../lib/api', () => ({
  isBackendAvailable: () => false,
  fetchAuthStatus: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
}));

vi.mock('../../../../lib/schema-loader', () => ({
  loadSchemaIntoStore: vi.fn(),
}));

const useQueryRunnerMock = vi.fn();
vi.mock('../hooks/useQueryRunner', () => ({
  useQueryRunner: () => useQueryRunnerMock(),
}));

import QueryEnginePage from '../QueryEnginePage';
import { useAuthStore } from '../../../../store/useAuthStore';

function baseRunnerState(overrides: Partial<ReturnType<typeof useQueryRunnerMock>> = {}) {
  return {
    selectedTableInBrowser: 'users',
    queryCode: 'SELECT * FROM users LIMIT 10;',
    queryResults: null,
    errorMsg: null,
    setQueryCode: vi.fn(),
    handleRunQuery: vi.fn(),
    handleFormatCode: vi.fn(),
    loadPresetQuery: vi.fn(),
    ...overrides,
  };
}

describe('QueryEnginePage', () => {
  beforeEach(() => {
    useQueryRunnerMock.mockReset();
    useAuthStore.setState({ queryTimeoutMs: 30000, queryRowCap: 1000 });
  });

  it('renders a persistent cap/timeout hint sourced from the auth store', () => {
    useAuthStore.setState({ queryTimeoutMs: 9000, queryRowCap: 250 });
    useQueryRunnerMock.mockReturnValue(baseRunnerState());

    render(<QueryEnginePage />);

    expect(screen.getByText('queryEngine.limitsHint')).toBeInTheDocument();
  });

  it('renders a truncation banner only when the result is truncated', () => {
    useQueryRunnerMock.mockReturnValue(
      baseRunnerState({
        queryResults: { columns: ['id'], rows: [{ id: 1 }], truncated: true },
      }),
    );

    render(<QueryEnginePage />);

    expect(screen.getByText('queryEngine.truncatedBanner')).toBeInTheDocument();
  });

  it('renders no truncation banner when the result is not truncated', () => {
    useQueryRunnerMock.mockReturnValue(
      baseRunnerState({
        queryResults: { columns: ['id'], rows: [{ id: 1 }], truncated: false },
      }),
    );

    render(<QueryEnginePage />);

    expect(screen.queryByText('queryEngine.truncatedBanner')).not.toBeInTheDocument();
  });

  it('renders a message naming the configured timeout when a 4xx timeout error comes back', () => {
    useAuthStore.setState({ queryTimeoutMs: 9000, queryRowCap: 250 });
    useQueryRunnerMock.mockReturnValue(
      baseRunnerState({
        errorMsg: 'Query exceeded the 9000ms statement timeout. Raise it with --query-timeout or INDIGODB_STUDIO_QUERY_TIMEOUT_MS.',
      }),
    );

    render(<QueryEnginePage />);

    expect(screen.getByText(/exceeded the 9000ms statement timeout/)).toBeInTheDocument();
  });
});
