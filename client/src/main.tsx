import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/inter';
import '@fontsource-variable/caveat';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startPresence } from './net/presence';
import { installErrorReporting } from './lib/analytics';

// #50: Firefox gets a cheaper path for the heavy decorative CSS (see index.css, data-engine).
if (/\bFirefox\//.test(navigator.userAgent)) document.documentElement.dataset.engine = 'gecko';

installErrorReporting(); // V15: hashed client errors (no message text leaves the browser)
startPresence(); // global /ws/presence socket on every page (V07)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
