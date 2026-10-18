import { Flag } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { LangToggle, LegalLayout, Loading, NotConfigured, type Lang } from './LegalLayout';
import { useLegal } from './useLegal';

/**
 * Notice and takedown (V12, #35): how to report infringing clips or abuse. The contact address
 * is the operator's email from `legal.json`.
 */
export default function Takedown() {
  const legal = useLegal();
  const [lang, setLang] = useState<Lang>('de');
  const de = lang === 'de';
  const subject = encodeURIComponent('Voicejack: Meldung / Notice');
  const contact =
    legal === undefined ? (
      <Loading />
    ) : legal === null ? (
      <NotConfigured />
    ) : (
      <p data-testid="takedown-email">
        <a href={`mailto:${legal.email}?subject=${subject}`}>{legal.email}</a>
      </p>
    );
  return (
    <LegalLayout
      title={de ? 'Inhalte melden' : 'Report content'}
      eyebrow="Notice & takedown"
      testId="legal-takedown"
    >
      <LangToggle lang={lang} onChange={setLang} />
      {de ? (
        <div className="flex flex-col gap-3" lang="de">
          <p>
            Ein Clip verletzt deine Rechte (zum Beispiel dein Urheberrecht), oder jemand verhält
            sich im Spiel oder in Nachrichten missbräuchlich? Melde es uns, wir sehen es uns so
            schnell wie möglich an.
          </p>
          {/* TODO(owner): if you want to promise a response time, add it here. */}
          <h2>Im Spiel melden</h2>
          <ul>
            <li>
              <strong>Clip:</strong> neben der Quellenangabe eines hochgeladenen Clips auf{' '}
              <Flag className="inline size-4" aria-hidden /> „Report clip“ tippen.
            </li>
            <li>
              <strong>Spieler in öffentlichen Spielen:</strong> „Report / kick“ in der Leiste über
              dem Spiel.
            </li>
            <li>
              <strong>Direktnachricht:</strong> im Chat-Fenster auf das Fahnen-Symbol (Report).
            </li>
          </ul>
          <h2>Per E-Mail melden</h2>
          {contact}
          <p>Damit wir schnell handeln können, schreib bitte dazu:</p>
          <ul>
            <li>deinen Namen und eine E-Mail-Adresse für Rückfragen,</li>
            <li>
              welcher Inhalt es ist, so genau wie möglich: Titel des Clips, Name der Bibliothek,
              Raumcode, Datum und Uhrzeit, Spielername, gern ein Screenshot,
            </li>
            <li>
              warum er rechtswidrig ist: welches Recht verletzt wird (z. B. dein Urheberrecht an
              einem Film) oder welches Verhalten gegen welche Regel verstößt,
            </li>
            <li>bei Urheberrechten: dass du Rechteinhaber bist oder in dessen Auftrag handelst,</li>
            <li>
              die Erklärung, dass deine Angaben nach bestem Wissen richtig und vollständig sind.
            </li>
          </ul>
          <h2>Was dann passiert</h2>
          <p>
            Wir prüfen die Meldung und sperren oder löschen den Inhalt, wenn er rechtswidrig ist
            oder gegen die Regeln verstößt. Bei wiederholten Verstößen kann der Upload für das Konto
            gesperrt werden. Wer den Inhalt hochgeladen hat, kann uns unter derselben Adresse
            widersprechen. Wie wir mit den Daten einer Meldung umgehen, steht in der{' '}
            <Link to="/datenschutz">Datenschutzerklärung</Link>.
          </p>
          <p className="text-zinc-500">Meldungen sind auf Deutsch oder Englisch möglich.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3" lang="en">
          <p>
            A clip infringes your rights (your copyright, for example), or someone is abusive in a
            game or in messages? Tell us and we will look at it as soon as we can.
          </p>
          <h2>Report in the game</h2>
          <ul>
            <li>
              <strong>Clip:</strong> tap <Flag className="inline size-4" aria-hidden /> "Report
              clip" next to the credit line of an uploaded clip.
            </li>
            <li>
              <strong>Player in a public game:</strong> "Report / kick" in the bar above the game.
            </li>
            <li>
              <strong>Direct message:</strong> the flag icon (Report) in the chat window.
            </li>
          </ul>
          <h2>Report by email</h2>
          {contact}
          <p>So we can act quickly, please include:</p>
          <ul>
            <li>your name and an email address for follow-up questions,</li>
            <li>
              which content it is, as precisely as you can: clip title, library name, room code,
              date and time, player name, a screenshot if you have one,
            </li>
            <li>
              why it is unlawful: which right is infringed (e.g. your copyright in a film) or which
              behaviour breaks which rule,
            </li>
            <li>for copyright: that you are the rights holder or act on their behalf,</li>
            <li>a statement that your information is accurate and complete to your knowledge.</li>
          </ul>
          <h2>What happens next</h2>
          <p>
            We review the notice and block or delete the content if it is unlawful or breaks the
            rules. Repeated violations can get uploads disabled for the account. Whoever uploaded
            the content can object at the same address. How we handle the data in a notice is in the{' '}
            <Link to="/datenschutz">privacy policy</Link>.
          </p>
          <p className="text-zinc-500">Notices are welcome in German or English.</p>
        </div>
      )}
    </LegalLayout>
  );
}
