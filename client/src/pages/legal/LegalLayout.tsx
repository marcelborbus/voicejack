import { legalEmail, type LegalPublic } from '@dub/shared';
import { AlertTriangle, ArrowLeft, Check, Copy } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { lines } from './useLegal';

export type Lang = 'de' | 'en';

/** Shared frame of the legal pages: back link, title, readable prose. */
export function LegalLayout({
  title,
  eyebrow,
  children,
  testId,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
  testId: string;
}) {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} · Voicejack`;
    return () => {
      document.title = prev;
    };
  }, [title]);
  useNoindex();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-testid={testId}>
      <Link
        to="/"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100"
      >
        <ArrowLeft className="size-4" /> Back to the game
      </Link>
      <Card>
        <CardContent className="flex flex-col gap-4 py-7 text-sm leading-relaxed text-zinc-300 sm:text-[15px] [&_a]:text-fuchsia-300 [&_a]:underline-offset-4 hover:[&_a]:underline [&_h2]:mt-4 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-zinc-50 [&_h3]:mt-2 [&_h3]:font-semibold [&_h3]:text-zinc-100 [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-zinc-100">
          <p className="tape w-fit">{eyebrow}</p>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-zinc-50 sm:text-4xl">
            {title}
          </h1>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

export function LangToggle({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <div
      role="group"
      aria-label="Language"
      className="inline-flex w-fit gap-1 rounded-xl bg-ink-850 p-1 text-xs font-semibold"
    >
      {(['de', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => onChange(l)}
          data-testid={`legal-lang-${l}`}
          className={cn(
            'rounded-lg px-3 py-1.5',
            lang === l ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-100',
          )}
        >
          {l === 'de' ? 'Deutsch' : 'English'}
        </button>
      ))}
    </div>
  );
}

/** Shown wherever the operator's details are needed but `legal.json` is missing. */
export function NotConfigured() {
  return (
    <div
      role="alert"
      data-testid="legal-missing"
      className="flex items-start gap-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-amber-100"
    >
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-300" />
      <div>
        <p className="font-semibold">Impressum not configured</p>
        <p className="text-sm text-amber-100/80">
          The operator's contact details have not been set up on this server yet (
          <code>legal.json</code>). Impressum noch nicht eingerichtet.
        </p>
      </div>
    </div>
  );
}

/** Name + address block of the operator. */
export function Operator({ legal }: { legal: LegalPublic }) {
  return (
    <address className="not-italic" data-testid="legal-operator">
      <strong>{legal.name}</strong>
      {lines(legal.address).map((l) => (
        <span key={l} className="block">
          {l}
        </span>
      ))}
      <span className="block">
        E-Mail: <ContactEmail legal={legal} />
      </span>
    </address>
  );
}

export function Loading() {
  return <p className="text-zinc-500">…</p>;
}

/**
 * `<meta name="robots" content="noindex">` while a legal page is shown (V13). The server also
 * puts it into the HTML of a direct load; this covers in-app navigation.
 */
function useNoindex(): void {
  useEffect(() => {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const added = !meta;
    meta ??= document.head.appendChild(document.createElement('meta'));
    meta.name = 'robots';
    const prev = meta.content;
    meta.content = 'noindex';
    return () => {
      if (added) meta.remove();
      else meta.content = prev;
    };
  }, []);
}

/**
 * The operator's address, joined in the browser from the parts `/api/legal` sends (V13,
 * anti-scraping): no `mailto:` link and no plain address in the JSON. Visible to every visitor,
 * with a copy button instead of the link.
 */
export function ContactEmail({ legal }: { legal: LegalPublic }) {
  const [copied, setCopied] = useState(false);
  const email = legalEmail(legal);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span data-testid="legal-email" className="select-all font-semibold text-zinc-100">
        {email}
      </span>
      <button
        type="button"
        aria-label="Copy email address"
        data-testid="legal-email-copy"
        className="rounded-md p-0.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        onClick={() => {
          void navigator.clipboard?.writeText(email).then(() => setCopied(true));
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
