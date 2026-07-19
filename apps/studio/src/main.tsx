import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { initCompiler } from '@indigodb/core';
import App from './app/App';
import './index.css';
import './i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';

// The .indigo compiler is Rust→WASM: instantiate it before rendering so every
// parse/resolve call in the app can stay synchronous. The module is a small
// local asset (~250 KB), so the gate is imperceptible.
initCompiler().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </StrictMode>,
  );
});
