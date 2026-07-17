/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { useThemeStore } from '../../../store/useThemeStore';

export interface UseSettingsFormReturn {
  themeAccent: string;
  setThemeAccent: (theme: string) => void;

  host: string;
  setHost: (host: string) => void;
  poolLimit: number;
  setPoolLimit: (limit: number) => void;
  autocommit: boolean;
  setAutocommit: (value: boolean) => void;
  safeUpdates: boolean;
  setSafeUpdates: (value: boolean) => void;
  saveSuccess: boolean;

  save: (onSaved: () => void) => void;
  resetDefaults: () => void;
}

export function useSettingsForm(): UseSettingsFormReturn {
  const { themeAccent, setThemeAccent } = useThemeStore();
  const [host, setHost] = useState('production-indigo-cluster.c6e83d8a.us-east-1.rds.amazonaws.com');
  const [poolLimit, setPoolLimit] = useState(50);
  const [autocommit, setAutocommit] = useState(true);
  const [safeUpdates, setSafeUpdates] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const save = (onSaved: () => void) => {
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
      onSaved();
    }, 1500);
  };

  const resetDefaults = () => {
    if (confirm('Are you sure you want to reset all cached variables to system defaults?')) {
      window.location.reload();
    }
  };

  return {
    themeAccent,
    setThemeAccent,
    host,
    setHost,
    poolLimit,
    setPoolLimit,
    autocommit,
    setAutocommit,
    safeUpdates,
    setSafeUpdates,
    saveSuccess,
    save,
    resetDefaults,
  };
}
