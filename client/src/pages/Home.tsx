import { ArrowRight, Mic, Sparkles, Trophy, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// T09 placeholder: layout only. T10 wires create/join.
export function Home() {
  return (
    <div className="grid flex-1 items-center gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-14">
      <section className="animate-fade-up">
        <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-semibold text-zinc-300">
          <Sparkles className="size-3.5 text-orange-300" /> A party game for 2–8 friends
        </p>
        <h1 className="font-display text-5xl font-extrabold leading-[0.95] sm:text-6xl lg:text-7xl">
          Everyone dubs
          <br />
          <span className="text-brand">the same scene.</span>
        </h1>
        <p className="mt-5 max-w-md text-lg text-zinc-400">
          One famous clip, three and a half minutes, your voice only. Then the dubs play back anonymously and
          everyone votes.
        </p>
        <ul className="mt-8 grid max-w-md gap-3 text-sm text-zinc-300 sm:grid-cols-3">
          <li className="flex items-center gap-2"><Users className="size-4 text-fuchsia-300" /> Voice lobby</li>
          <li className="flex items-center gap-2"><Mic className="size-4 text-pink-300" /> Record in layers</li>
          <li className="flex items-center gap-2"><Trophy className="size-4 text-orange-300" /> Vote 0–10</li>
        </ul>
      </section>

      <Card className="animate-fade-up [animation-delay:80ms]">
        <CardHeader>
          <CardTitle>Start a party</CardTitle>
          <CardDescription>Create a room and send the link to your friends.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Your name</Label>
            <Input id="name" placeholder="e.g. Morgan Freeman" maxLength={20} />
          </div>
          <Button size="xl">
            Create room <ArrowRight />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
