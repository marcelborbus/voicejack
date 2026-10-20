import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/inter';
import '@fontsource-variable/caveat';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startPresence } from './net/presence';
import { installErrorReporting } from './lib/analytics';
import { prefetchMic } from './audio/mic';
import { joinRoom } from './state/session';
import { getToken, normalizeRoomCode } from './state/storage';

// #50: Firefox gets a cheaper path for the heavy decorative CSS (see index.css, data-engine).
if (/\bFirefox\//.test(navigator.userAgent)) document.documentElement.dataset.engine = 'gecko';

installErrorReporting(); // V15: hashed client errors (no message text leaves the browser)
startPresence(); // global /ws/presence socket on every page (V07)

// #53: on /r/CODE with a stored token, open the room socket and the mic while React boots (the
// room route reuses this session). Without a token the name prompt comes first, and by then
// `/api/me` has set the session cookie (V03), so nothing changes there.
const roomPath = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
const roomCode = roomPath ? normalizeRoomCode(decodeURIComponent(roomPath[1]!)) : '';
if (roomCode && getToken(roomCode)) {
  joinRoom(roomCode);
  prefetchMic();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
