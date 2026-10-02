/**
 * Renderer entry point.
 *
 * The Supabase client is configured here, before React mounts, so no component
 * can ever call a service against an unconfigured client. The Electron
 * renderer is a plain browser context — sessions persist in `localStorage`,
 * which is exactly what the shared storage auto-detection picks.
 */

import './styles/global.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { configureSupabase } from '@wallet/shared';

import App from './App';
import { applyTheme, readStoredTheme } from './theme';

// Before the first paint, so the window never flashes the wrong theme. This
// has to be a module-level call rather than an inline <script> in index.html:
// the production CSP is `script-src 'self'` and would block inline code.
applyTheme(readStoredTheme());

// Which platform's window chrome the renderer is drawing. macOS keeps its
// native traffic lights, so `global.css` hides the custom caption cluster
// there and pads the top bar to clear them. Absent a bridge (a plain browser
// tab) this is 'web', which draws the cluster.
document.documentElement.dataset['platform'] = window.desktop?.platform ?? 'web';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Renderer bootstrap failed: #root was not found in index.html.');
}

const root = ReactDOM.createRoot(rootElement);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  const missing = [
    !SUPABASE_URL ? 'VITE_SUPABASE_URL' : null,
    !SUPABASE_ANON_KEY ? 'VITE_SUPABASE_ANON_KEY' : null,
  ].filter((value): value is string => value !== null);

  root.render(
    <div className="center-state">
      <h1 style={{ margin: 0, fontSize: 20 }}>Configuration missing</h1>
      <p style={{ margin: 0, maxWidth: 480, textAlign: 'center' }}>
        {missing.join(' and ')} {missing.length === 1 ? 'is' : 'are'} not set.
        Copy <code>apps/desktop/.env.example</code> to{' '}
        <code>apps/desktop/.env</code>, fill in your Supabase project
        credentials, then restart the dev server.
      </p>
    </div>,
  );
} else {
  configureSupabase({
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    storageKey: 'sara-wallet.auth',
    // A desktop app has no OAuth redirect landing page to parse.
    detectSessionInUrl: false,
  });

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
