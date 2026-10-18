import {
  MOOD_EMOJI,
  type AdminAnalyticsResponse,
  type FeedbackItem,
  type FeedbackStatus,
  type FunnelStep,
} from '@dub/shared';
import { ArrowLeft, BarChart3, Check, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { AdminError, adminApi } from './api';
import { BarList, ColumnChart, HeatCell, StatTile, compact } from './charts';

const RANGES = [7, 30, 90, 365] as const;
const DAY_MS = 24 * 3600_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const FUNNEL_LABEL: Record<FunnelStep, string> = {
  visit: 'Page views',
  room: 'Joined a room',
  started: 'Game started',
  finished: 'Game finished',
  again: 'Played again',
};
const PHASE_LABEL: Record<string, string> = {
  DUBBING: 'Dubbing',
  SHOWCASE: 'Showcase',
  ROUND_RESULTS: 'Round results',
};

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');
const fmt1 = (n: number | null) => (n === null ? '–' : n.toFixed(1));

/** `/admin/analytics` (V15): aggregate product analytics + the anonymous feedback inbox. */
export default function AnalyticsPage() {
  const [range, setRange] = useState<number>(30);
  const [status, setStatus] = useState<FeedbackStatus>('open');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminAnalyticsResponse | null>(null);
  const [denied, setDenied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const now = Date.now();
    try {
      setData(
        await adminApi.analytics({
          from: day(now - (range - 1) * DAY_MS),
          to: day(now),
          page,
          status,
        }),
      );
    } catch (e) {
      if (e instanceof AdminError && e.status === 403) setDenied('Admins only.');
      else
        toast('Could not load analytics', { description: (e as Error).message, variant: 'error' });
    }
  }, [range, page, status]);

  useEffect(() => {
    document.title = 'Analytics · Voicejack';
    void load();
  }, [load]);

  if (denied) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <Card className="max-w-md">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <ShieldAlert className="size-10 text-rose-300" />
            <p className="font-display text-xl font-bold">No access</p>
            <p className="text-sm text-zinc-400">{denied}</p>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const t = data.totals;
  const first = data.funnel[0]?.count ?? 0;
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6"
      data-testid="analytics-page"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-3xl font-bold tracking-tight">
            <BarChart3 className="size-7 text-zinc-400" /> Analytics
          </h1>
          <p className="text-sm text-zinc-400">
            {data.from} – {data.to} · aggregate counts only, no personal data
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={range === r ? 'secondary' : 'ghost'}
                onClick={() => {
                  setRange(r);
                  setPage(1);
                }}
              >
                {r === 365 ? '1 y' : `${r} d`}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link to="/admin">
              <ArrowLeft /> Libraries
            </Link>
          </Button>
        </div>
      </header>

      <section
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        aria-label="Key numbers"
        data-testid="analytics-tiles"
      >
        <StatTile
          label="Active today"
          value={compact(data.active.dau)}
          sub="profiles, last 24 h"
          testId="tile-dau"
        />
        <StatTile label="Active this week" value={compact(data.active.wau)} sub="last 7 days" />
        <StatTile label="Active this month" value={compact(data.active.mau)} sub="last 30 days" />
        <StatTile
          label="Games finished"
          value={compact(t.gamesFinished)}
          sub={`of ${compact(t.gamesStarted)} started (${pct(t.gamesFinished, t.gamesStarted)})`}
        />
        <StatTile
          label="Avg players"
          value={fmt1(t.avgPlayers)}
          sub={`avg vote ${fmt1(t.avgVote)} / 10`}
        />
        <StatTile
          label="Sign-ups"
          value={compact(t.signups)}
          sub={`voice opt-in ${pct(t.voiceOptIns, t.publicSeats)} of public seats`}
        />
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Page views per day">
          <ColumnChart
            data={data.daily.map((d) => ({ key: d.day, value: d.visits }))}
            label="page views"
            testId="chart-visits"
          />
        </Panel>
        <Panel title="Games started per day">
          <ColumnChart
            data={data.daily.map((d) => ({ key: d.day, value: d.games }))}
            label="games"
          />
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel
          title="Funnel"
          hint="Counts of events, not people: page views, then player seats in rooms and games."
        >
          <BarList
            rows={data.funnel.map((f) => ({
              key: f.step,
              label: FUNNEL_LABEL[f.step],
              value: f.count,
            }))}
            label="events"
            note={(r, i) => (i === 0 ? null : pct(r.value, first))}
            testId="chart-funnel"
          />
        </Panel>
        <Panel title="Drop-off by phase" hint="Players who left a game before the final screen.">
          <BarList
            rows={data.dropoff.map((d) => ({
              ...d,
              value: d.count,
              label: PHASE_LABEL[d.key] ?? d.key,
            }))}
            label="drop-offs"
            empty="Nobody dropped out."
          />
        </Panel>
      </div>

      <Panel
        title="Weekly retention"
        hint="Profiles by the week they were first seen. Seen = last visit in that week or later (only the latest visit is stored, so this is a lower bound). Played = a recorded public game in that week."
      >
        <CohortTable cohorts={data.cohorts} />
      </Panel>

      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
        {(
          [
            ['Players per game', 'players'],
            ['Rounds per finished game', 'rounds'],
            ['Takes per dub', 'takes'],
            ['Re-records per dub', 'rerecords'],
            ['Vote scores', 'voteScore'],
            ['Queue wait', 'queueWait'],
            ['Browser', 'browser'],
            ['Device', 'device'],
          ] as const
        ).map(([title, key]) => (
          <Panel key={key} title={title}>
            <BarList
              rows={(data.breakdowns[key] ?? []).map((r) => ({ key: r.key, value: r.count }))}
              label="times"
            />
          </Panel>
        ))}
      </div>

      <Panel title="Clips" hint="Picks = dealt to a human player. Completion = ended with a dub.">
        <ClipTable clips={data.clips} />
      </Panel>

      <Panel
        title="Client errors"
        hint="Hashes of normalized error messages (the browser console logs “[vj] error <hash>”)."
      >
        {data.errors.length === 0 ? (
          <p className="text-sm text-zinc-500">No errors reported.</p>
        ) : (
          <Table head={['Hash', 'Source', 'Page', 'Count', 'Last seen']} testId="errors-table">
            {data.errors.map((e) => (
              <tr key={`${e.hash}${e.where}${e.route}`} className="border-t border-white/[0.06]">
                <td className="px-3 py-2 font-mono text-xs">{e.hash}</td>
                <td className="px-3 py-2">{e.where}</td>
                <td className="px-3 py-2">{e.route}</td>
                <td className="px-3 py-2 tabular-nums">{e.count}</td>
                <td className="px-3 py-2 text-zinc-400">{e.lastDay}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <FeedbackInbox
        data={data}
        status={status}
        onStatus={(s) => {
          setStatus(s);
          setPage(1);
        }}
        onPage={setPage}
        onChanged={load}
      />
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg sm:text-lg">{title}</CardTitle>
        {hint && <p className="text-xs text-zinc-500">{hint}</p>}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

function Table({
  head,
  children,
  testId,
}: {
  head: string[];
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid={testId}>
        <thead className="text-xs text-zinc-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-zinc-200">{children}</tbody>
      </table>
    </div>
  );
}

function CohortTable({ cohorts }: { cohorts: AdminAnalyticsResponse['cohorts'] }) {
  const [mode, setMode] = useState<'active' | 'played'>('active');
  if (cohorts.length === 0) return <p className="text-sm text-zinc-500">No profiles yet.</p>;
  const weeks = Math.max(...cohorts.map((c) => c.active.length));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1" role="group" aria-label="Retention measure">
        <Button
          size="sm"
          variant={mode === 'active' ? 'secondary' : 'ghost'}
          onClick={() => setMode('active')}
        >
          Seen again
        </Button>
        <Button
          size="sm"
          variant={mode === 'played' ? 'secondary' : 'ghost'}
          onClick={() => setMode('played')}
        >
          Played
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="text-sm" data-testid="cohort-table">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Week of</th>
              <th className="px-3 py-1.5 text-right font-medium">Profiles</th>
              {Array.from({ length: weeks }, (_, k) => (
                <th key={k} className="px-2 py-1.5 font-medium">
                  W{k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.week}>
                <td className="px-3 py-1.5 text-zinc-300">{c.week}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{c.size}</td>
                {Array.from({ length: weeks }, (_, k) => {
                  const v = c[mode][k];
                  if (v === undefined)
                    return (
                      <HeatCell key={k} share={null}>
                        {''}
                      </HeatCell>
                    );
                  const share = c.size ? v / c.size : 0;
                  return (
                    <HeatCell key={k} share={share}>
                      <span title={`${v} of ${c.size}`}>{Math.round(share * 100)}%</span>
                    </HeatCell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClipTable({ clips }: { clips: AdminAnalyticsResponse['clips'] }) {
  const [sort, setSort] = useState<'picks' | 'avgScore' | 'completion'>('picks');
  if (clips.length === 0) return <p className="text-sm text-zinc-500">No clips played yet.</p>;
  const rows = [...clips].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1)).slice(0, 50);
  const th = (key: typeof sort, label: string) => (
    <button
      type="button"
      className={sort === key ? 'text-zinc-100' : ''}
      onClick={() => setSort(key)}
    >
      {label}
      {sort === key ? ' ↓' : ''}
    </button>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="clip-table">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Clip</th>
            <th className="px-3 py-2 font-medium">{th('picks', 'Picks')}</th>
            <th className="px-3 py-2 font-medium">{th('completion', 'Completion')}</th>
            <th className="px-3 py-2 font-medium">Votes</th>
            <th className="px-3 py-2 font-medium">{th('avgScore', 'Avg score')}</th>
          </tr>
        </thead>
        <tbody className="text-zinc-200">
          {rows.map((c) => (
            <tr key={c.clipId} className="border-t border-white/[0.06]">
              <td className="max-w-[16rem] truncate px-3 py-2" title={c.clipId}>
                {c.title ?? <span className="text-zinc-500">{c.clipId} (deleted)</span>}
              </td>
              <td className="px-3 py-2 tabular-nums">{c.picks}</td>
              <td className="px-3 py-2 tabular-nums">
                {c.completion === null ? '–' : `${Math.round(c.completion * 100)}%`}
              </td>
              <td className="px-3 py-2 tabular-nums">{c.votes}</td>
              <td className="px-3 py-2 tabular-nums">{fmt1(c.avgScore)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeedbackInbox({
  data,
  status,
  onStatus,
  onPage,
  onChanged,
}: {
  data: AdminAnalyticsResponse;
  status: FeedbackStatus;
  onStatus: (s: FeedbackStatus) => void;
  onPage: (p: number) => void;
  onChanged: () => Promise<void>;
}) {
  const fb = data.feedback;
  const pages = Math.max(1, Math.ceil(fb.total / fb.pageSize));
  const moodTotal = fb.moods.reduce((n, m) => n + m.count, 0);
  const act = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
      await onChanged();
    } catch (e) {
      toast('Action failed', { description: (e as Error).message, variant: 'error' });
    }
  };
  return (
    <Card data-testid="feedback-inbox">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle className="text-lg sm:text-lg">Feedback</CardTitle>
          <p className="text-xs text-zinc-500">
            Anonymous; kept 1 year.{' '}
            {moodTotal > 0 &&
              fb.moods
                .map((m) => `${MOOD_EMOJI[Number(m.key)] ?? m.key} ${pct(m.count, moodTotal)}`)
                .join(' · ')}
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Feedback filter">
          {(['open', 'resolved', 'all'] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? 'secondary' : 'ghost'}
              onClick={() => onStatus(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {fb.items.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing here.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {fb.items.map((f) => (
              <FeedbackRow
                key={f.id}
                item={f}
                onResolve={act(() => adminApi.resolveFeedback(f.id, f.resolvedAt === null))}
                onDelete={act(() => adminApi.deleteFeedback(f.id))}
              />
            ))}
          </ul>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-sm text-zinc-400">
            <Button
              size="sm"
              variant="ghost"
              disabled={fb.page <= 1}
              onClick={() => onPage(fb.page - 1)}
            >
              Previous
            </Button>
            <span>
              {fb.page} / {pages}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={fb.page >= pages}
              onClick={() => onPage(fb.page + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FeedbackRow({
  item,
  onResolve,
  onDelete,
}: {
  item: FeedbackItem;
  onResolve: () => void;
  onDelete: () => void;
}) {
  const c = item.context;
  return (
    <li
      className="flex flex-col gap-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 sm:flex-row sm:items-start"
      data-testid="feedback-item"
    >
      <span
        className="text-2xl"
        aria-label={item.kind === 'bug' ? 'bug report' : `mood ${item.mood}`}
      >
        {item.kind === 'bug' ? '🐞' : (MOOD_EMOJI[item.mood ?? 0] ?? '·')}
      </span>
      <div className="min-w-0 flex-1">
        {/* Plain text only: React escapes it, and the server stripped control characters. */}
        <p
          className="whitespace-pre-wrap break-words text-sm text-zinc-100"
          data-testid="feedback-comment"
        >
          {item.comment || <span className="text-zinc-500">(no comment)</span>}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
          <span>{new Date(item.createdAt).toLocaleString()}</span>
          <span>page {c.route}</span>
          {c.phase && <span>phase {c.phase}</span>}
          {c.version && <span>v{c.version}</span>}
          {c.errors.length > 0 && <span className="font-mono">errors {c.errors.join(', ')}</span>}
          {item.resolvedAt !== null && <Badge variant="outline">resolved</Badge>}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button size="sm" variant="ghost" onClick={onResolve} data-testid="feedback-resolve">
          {item.resolvedAt === null ? (
            <>
              <Check /> Resolve
            </>
          ) : (
            <>
              <RotateCcw /> Reopen
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          aria-label="Delete feedback"
          data-testid="feedback-delete"
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}
