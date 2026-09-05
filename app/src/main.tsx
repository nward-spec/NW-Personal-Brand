import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './styles.css';
import { applyAccent, loadAccent } from './web/theme';

applyAccent(loadAccent());

// Service worker: pre-caches the app shell so it opens offline and updates
// itself in the background on the next launch.
// VITE_NO_SW=1 builds a single-page bundle for hosts that cannot serve a service worker.
if (!import.meta.env.VITE_NO_SW) registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
