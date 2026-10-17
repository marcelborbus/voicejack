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
              path="admin/*"
              element={
                <Suspense>
                  <AdminPage />
                </Suspense>
              }
            />
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
