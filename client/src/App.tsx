import { BrowserRouter, Route, Routes } from 'react-router';
import { Shell } from '@/components/layout/Shell';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Home } from '@/pages/Home';
import { NotFound } from '@/pages/NotFound';
import { Room } from '@/pages/Room';

export function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Home />} />
            <Route path="r/:code" element={<Room />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </TooltipProvider>
  );
}
