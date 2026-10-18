import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Shell } from '@/components/layout/Shell';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Home } from '@/pages/Home';
import { NotFound } from '@/pages/NotFound';
import { Room } from '@/pages/Room';

// Admin (V05): own chunk, only fetched on /admin.
const AdminPage = lazy(() => import('@/admin/AdminPage'));
// V15 analytics dashboard (admin chunk).
const AnalyticsPage = lazy(() => import('@/admin/AnalyticsPage'));
// V06 "My clips" (registered users' private libraries).
const LibraryPage = lazy(() => import('@/pages/library/LibraryPage'));
// V12 legal pages: own chunk each.
const Impressum = lazy(() => import('@/pages/legal/Impressum'));
const Datenschutz = lazy(() => import('@/pages/legal/Datenschutz'));
const Takedown = lazy(() => import('@/pages/legal/Takedown'));
// Dev-only pages (dead code in production builds).
const DevPlayerPage = import.meta.env.DEV ? lazy(() => import('@/dub/DevPlayerPage')) : null;

export function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Home />} />
            <Route path="r/:code" element={<Room />} />
            <Route
              path="admin/analytics"
              element={
                <Suspense>
                  <AnalyticsPage />
                </Suspense>
              }
            />
            <Route
              path="admin/*"
              element={
                <Suspense>
                  <AdminPage />
                </Suspense>
              }
            />
            <Route
              path="library"
              element={
                <Suspense>
                  <LibraryPage />
                </Suspense>
              }
            />
            {(
              [
                ['impressum', Impressum],
                ['datenschutz', Datenschutz],
                ['takedown', Takedown],
              ] as const
            ).map(([path, Page]) => (
              <Route
                key={path}
                path={path}
                element={
                  <Suspense>
                    <Page />
                  </Suspense>
                }
              />
            ))}
            {DevPlayerPage && (
              <Route
                path="dev/player"
                element={
                  <Suspense>
                    <DevPlayerPage />
                  </Suspense>
                }
              />
            )}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </TooltipProvider>
  );
}
