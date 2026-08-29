/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';

/**
 * Rendered by `App` instead of the normal shell whenever this Studio instance
 * has a password configured and the current session isn't authenticated yet
 * (see `useAuthStore`). The error message is intentionally the server's exact
 * generic text — no client-side hint distinguishes "wrong password" from
 * "auth unconfigured".
 */
export default function LoginScreen() {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const login = useAuthStore((state) => state.login);
  const loginError = useAuthStore((state) => state.loginError);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await login(password);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-[#09090b] text-white font-sans">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 p-8 bg-zinc-950 border border-zinc-800 rounded-3xl shadow-lg"
      >
        <div className="flex items-center gap-2 text-white">
          <Lock className="w-5 h-5 text-zinc-400" />
          <h1 className="text-lg font-bold">{t('auth.login.title')}</h1>
        </div>
        <p className="text-xs text-zinc-500">{t('auth.login.description')}</p>

        <div className="space-y-1">
          <label htmlFor="studio-password" className="text-xs font-semibold text-zinc-300">
            {t('auth.login.password_label')}
          </label>
          <input
            id="studio-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            autoComplete="current-password"
            className="w-full rounded-xl bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
          />
        </div>

        {loginError && (
          <p role="alert" className="text-xs text-red-400">
            {loginError}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="w-full bg-white hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed text-black rounded-xl py-2 text-xs font-bold uppercase tracking-wider transition-all"
        >
          {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
        </button>
      </form>
    </div>
  );
}
