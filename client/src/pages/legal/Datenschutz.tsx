import { DM_RETENTION_DAYS, type LegalInfo } from '@dub/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  LangToggle,
  LegalLayout,
  Loading,
  NotConfigured,
  Operator,
  type Lang,
} from './LegalLayout';
import { useLegal } from './useLegal';

/**
 * Datenschutzerklärung (V12, #35). Every statement here was checked against the code and the
 * host config on the date below. When the data handling changes, update this page and the date.
 * Open points for the owner are marked `TODO(owner)` (source comments, not shown to visitors).
 */
export const PRIVACY_STAND = { de: '17. Oktober 2026', en: '17 October 2026' } as const;

// Facts the text relies on (keep in sync with the code / host).
const NGINX_LOG_DAYS = 14; // /etc/logrotate.d/nginx: daily, rotate 14
const MAIL_LOG_WEEKS = 5; // /etc/logrotate.d/rsyslog: weekly, rotate 4 (+ the current file)
const GUEST_RETENTION_DAYS = 180; // server Accounts GUEST_RETENTION_MS
const SESSION_DAYS = 30; // server Accounts SESSION_TTL_MS
const STUN_HOST = 'stun.l.google.com'; // server config DEFAULT_ICE (no ICE_SERVERS override in prod)

export default function Datenschutz() {
  const legal = useLegal();
  const [lang, setLang] = useState<Lang>('de');
  return (
    <LegalLayout
      title={lang === 'de' ? 'Datenschutzerklärung' : 'Privacy policy'}
      eyebrow={lang === 'de' ? 'Datenschutz' : 'Privacy'}
      testId="legal-datenschutz"
    >
      <LangToggle lang={lang} onChange={setLang} />
      {lang === 'de' ? <German legal={legal} /> : <English legal={legal} />}
    </LegalLayout>
  );
}

function Controller({ legal }: { legal: LegalInfo | null | undefined }) {
  if (legal === undefined) return <Loading />;
  if (legal === null) return <NotConfigured />;
  return <Operator legal={legal} />;
}

function German({ legal }: { legal: LegalInfo | null | undefined }) {
  return (
    <div className="flex flex-col gap-3" lang="de">
      <p className="text-zinc-500">Stand: {PRIVACY_STAND.de}</p>
      <p>
        Voicejack ist ein kostenloses Partyspiel, das eine Einzelperson als Hobbyprojekt betreibt.
        Es gibt <strong>keine Werbung, keine Analyse- oder Tracking-Dienste</strong> und keine
        Skripte, Schriften oder Bilder von fremden Servern. Hier steht, welche Daten trotzdem
        anfallen, wofür und wie lange.
      </p>

      <h2>1. Verantwortlicher</h2>
      <Controller legal={legal} />
      <p>
        Weitere Angaben im <Link to="/impressum">Impressum</Link>.
      </p>

      <h2>2. Hosting</h2>
      {/* TODO(owner): confirm the Art. 28 DSGVO data processing agreement (AVV) with Hetzner is
          accepted in the Hetzner console. The server is in hel1-dc2 (Helsinki), per the Hetzner
          metadata service on 2026-10-17, not in Germany. */}
      <p>
        Voicejack läuft auf einem Server der Hetzner Online GmbH, Industriestr. 25, 91710
        Gunzenhausen, Deutschland, im Rechenzentrum <strong>Helsinki, Finnland (EU)</strong>.
        Hetzner verarbeitet die Daten in unserem Auftrag (Art. 28 DSGVO).
      </p>

      <h2>3. Server-Logs</h2>
      <p>
        Bei jedem Aufruf speichert der Webserver (nginx): IP-Adresse, Datum und Uhrzeit, die
        aufgerufene Adresse, Statuscode, übertragene Datenmenge, die zuvor besuchte Seite (Referrer)
        und die Browserkennung (User-Agent). Die Logs werden täglich rotiert und nach{' '}
        {NGINX_LOG_DAYS} Tagen gelöscht.
      </p>
      <p>
        Die Anwendung selbst protokolliert Anfragen nur mit Methode, Pfad (ohne Parameter),
        Statuscode und Zeitpunkt sowie Fehler, <strong>ohne IP-Adresse</strong>, Browserkennung oder
        andere Kopfzeilen. Dieses Protokoll ist auf 30 MB begrenzt; ältere Einträge werden
        überschrieben. Für Ratenbegrenzungen und Sperren nach Meldungen (Schutz vor Missbrauch) wird
        die IP-Adresse kurzzeitig im Arbeitsspeicher gehalten und nicht gespeichert.
      </p>
      <p>
        Zweck: Betrieb, Fehlersuche und Abwehr von Angriffen. Rechtsgrundlage: Art. 6 Abs. 1 lit. f
        DSGVO (berechtigtes Interesse an einem sicheren, funktionierenden Dienst).
      </p>

      <h2>4. Cookie und Speicher im Browser</h2>
      <p>
        Wir setzen genau <strong>ein Cookie</strong>: <code>vj_session</code>. Es enthält eine
        zufällige Kennung, die deinen Browser beim ersten Besuch mit einem Gastprofil (bzw. später
        deinem Konto) verknüpft. Es ist HttpOnly, SameSite=Lax, gilt {SESSION_DAYS} Tage und
        verlängert sich bei Nutzung. Ohne dieses Cookie funktioniert das Spiel nicht (Räume,
        Wiederverbinden, Anmeldung). Es ist daher technisch unbedingt erforderlich (§ 25 Abs. 2 Nr.
        2 TDDDG); eine Einwilligung und ein Cookie-Banner sind nicht nötig.
      </p>
      <p>Außerdem speichert die Seite im Browser (localStorage / sessionStorage):</p>
      <ul>
        <li>
          <code>dub.name</code>: der zuletzt verwendete Spielername, zum Vorausfüllen.
        </li>
        <li>
          <code>dub.token.&lt;RAUMCODE&gt;</code>: ein zufälliges Raum-Token, damit du nach einem
          Neuladen in denselben Raum zurückkommst. Es wird dafür an unseren Server übermittelt.
        </li>
        <li>
          <code>vj.sfx</code>: ob die Spielgeräusche an oder aus sind.
        </li>
        <li>
          <code>vj.supportShown</code> (nur für die Sitzung): ob der Unterstützungshinweis schon
          gezeigt wurde.
        </li>
      </ul>
      <p>Nichts davon dient der Verfolgung über andere Websites hinweg.</p>

      <h2>5. Gastprofil und Konto</h2>
      <p>
        Für jeden Browser legen wir automatisch ein <strong>Gastprofil</strong> an: eine zufällige
        Kennung, der zuletzt verwendete Anzeigename, Elo-Wertung, Anzahl öffentlicher Spiele sowie
        Erstellungs- und letzter Nutzungszeitpunkt. Gastprofile, die {GUEST_RETENTION_DAYS} Tage
        nicht genutzt wurden, werden automatisch gelöscht.
      </p>
      {/* TODO(owner): V09 (Elo + game history, migration 006_games) was not committed when this
          was written. Once it ships, check what `games` / `game_players` keep (place, score, Elo
          before/after, room code?) and for how long, and describe it here. */}
      <p>
        Mit einem optionalen <strong>Konto</strong> kommt deine E-Mail-Adresse hinzu; Wertung und
        Spiele des Gastprofils bleiben erhalten. Dein Anzeigename ist für die Mitspieler im selben
        Raum sichtbar; dein Avatar wird im Browser aus dem Namen erzeugt. Rechtsgrundlage: Art. 6
        Abs. 1 lit. b DSGVO (Bereitstellung des Spiels, das du nutzen möchtest).
      </p>

      <h2>6. Anmeldung per E-Mail-Link</h2>
      {/* TODO(owner): confirm the AVV with goneo, which relays our outgoing mail
          (postconf relayhost = [smtp.goneo.de]:587), and add goneo's postal address if wanted. */}
      <p>
        Zur Anmeldung schicken wir dir einen Link per E-Mail. Dafür speichern wir deine Adresse,
        einen Hash des Links und den Zeitpunkt; der Link gilt 15 Minuten und der Eintrag wird kurz
        danach gelöscht. Die Mail verschickt unser eigener Mailserver auf demselben Server über den
        Mail-Anbieter goneo Internet GmbH (Deutschland). Das Mail-Protokoll des Servers enthält die
        Empfängeradresse und wird nach etwa {MAIL_LOG_WEEKS} Wochen gelöscht.
      </p>

      <h2>7. Spielen: Räume und Aufnahmen</h2>
      <p>
        Raumdaten (Namen, Punkte, Stimmen) liegen nur im Arbeitsspeicher, solange der Raum besteht.
        Das Mikrofon wird nur nach deiner Freigabe im Browser genutzt. Deine{' '}
        <strong>Dub-Aufnahmen</strong> werden auf unseren Server hochgeladen und an die Mitspieler
        im Raum ausgeliefert, damit alle sie anhören und bewerten können. Sie werden gelöscht,
        sobald der Raum geschlossen wird (spätestens 3 Stunden nach seiner Erstellung oder 10
        Minuten nachdem der letzte Spieler gegangen ist) sowie bei jedem Neustart des Servers. Sie
        sind nicht in Backups enthalten.
      </p>
      <p>
        <strong>„Video speichern“</strong> erzeugt das Video vollständig in deinem Browser; es wird
        nicht hochgeladen. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.
      </p>

      <h2>8. Sprachchat (WebRTC)</h2>
      {/* TODO(owner): verify Google LLC's active Data Privacy Framework certification
          (dataprivacyframework.gov) before relying on it. */}
      <p>
        Der Sprachchat läuft <strong>direkt zwischen den Browsern</strong> der Spieler
        (Peer-to-Peer). Die Sprache geht nicht über unseren Server und wird nicht aufgezeichnet;
        unser Server vermittelt nur den Verbindungsaufbau. In privaten Räumen baut dein Browser zu
        jedem Mitspieler eine direkte Verbindung auf, auch wenn du stummgeschaltet bist. In{' '}
        <strong>öffentlichen Spielen</strong> („Zufälliges Spiel“) ist der Sprachchat aus, bis du
        „Tap to talk“ oder „Tap to listen“ antippst; eine Verbindung entsteht nur zwischen zwei
        Spielern, die beide zugestimmt haben, und wird getrennt, sobald du beides wieder
        ausschaltest.{' '}
        <strong>
          Über eine solche Verbindung ist deine IP-Adresse für den Mitspieler technisch sichtbar.
        </strong>
      </p>
      <p>
        Um einen Verbindungsweg zu finden, fragt dein Browser den STUN-Server{' '}
        <code>{STUN_HOST}</code> der Google LLC (USA) nach deiner öffentlichen IP-Adresse. Google
        erhält dabei deine IP-Adresse und deinen Port, aber keine Sprache und keine Spieldaten. Das
        ist eine Übermittlung in ein Drittland (USA); sie stützt sich auf den
        Angemessenheitsbeschluss der EU-Kommission zum EU-US Data Privacy Framework (Art. 45 DSGVO),
        unter dem Google LLC zertifiziert ist. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO
        (Sprachchat als Teil des Spiels).
      </p>

      <h2>9. Öffentliche Spiele und Meldungen</h2>
      {/* TODO(owner): reports have no automatic deletion yet. Decide a retention (e.g. delete
          resolved reports after N months) and state it here. */}
      <p>
        Für „Zufälliges Spiel“ halten wir die Warteschlange (Spielername, Wartezeit) nur im
        Arbeitsspeicher. Wenn du jemanden meldest (Spieler, Nachricht oder Clip), speichern wir
        Zeitpunkt, Raumcode, die Namen und Profilkennungen von dir und der gemeldeten Person, deinen
        Grund und gegebenenfalls die gemeldete Nachricht bzw. die Clip-Kennung. Meldungen werden zur
        Moderation aufbewahrt, auch wenn die Nachricht selbst schon gelöscht ist. Rechtsgrundlage:
        Art. 6 Abs. 1 lit. f DSGVO (Schutz der Mitspieler, Durchsetzung der Regeln).
      </p>

      <h2>10. Freunde und Direktnachrichten</h2>
      <p>
        Nur mit Konto. Wir speichern Freundschaften und Freundschaftsanfragen, Blockierungen und
        deine Direktnachrichten (Text, Zeitpunkt, gelesen). Freunde sehen, ob du online oder im
        Spiel bist. Direktnachrichten werden nach {DM_RETENTION_DAYS} Tagen automatisch gelöscht.
        Eine gemeldete Nachricht bleibt als Zitat in der Meldung erhalten (siehe 9).
        Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.
      </p>

      <h2>11. Eigene Clips</h2>
      <p>
        Angemeldete Spieler können eigene Videoclips hochladen. Wir speichern das (auf unserem
        Server umgewandelte) Video, Titel und Quellenangabe, deine Bestätigung, dass du die Rechte
        hast, sowie Upload-Zeitpunkte für die Upload-Limits. Die Clips sind nur für dich und für
        Mitspieler in Räumen sichtbar, die deine Bibliothek verwenden. Sie bleiben gespeichert, bis
        du sie oder dein Konto löschst oder wir sie nach einer Meldung entfernen (siehe{' '}
        <Link to="/takedown">Inhalte melden</Link>).
      </p>

      <h2>12. Backups</h2>
      {/* TODO(owner): state where the backups of /opt/voicejack/data/db and data/library go
          (/opt/backups, any off-site copy?) and how long they are kept. */}
      <p>
        Die Datenbank (Profile, Konten, Freunde, Nachrichten, Meldungen) und hochgeladene Clips
        werden regelmäßig gesichert. Gelöschte Daten können daher noch für die Aufbewahrungsdauer
        der Backups in diesen enthalten sein.
      </p>

      <h2>13. Unterstützen (Liberapay)</h2>
      <p>
        Der Button „Chip in“ / „Support“ ist ein einfacher Link zu liberapay.com. Auf Voicejack wird
        nichts von Liberapay geladen; erst wenn du den Link öffnest, gilt die Datenschutzerklärung
        von Liberapay.
      </p>

      <h2>14. Konto löschen</h2>
      <p>
        Im Kontomenü (oben rechts) unter <strong>„Delete account“</strong>. Dabei werden sofort
        E-Mail-Adresse und Name entfernt, alle Sitzungen beendet, Freundschaften, Blockierungen und
        Direktnachrichten gelöscht sowie deine eigenen Clip-Bibliotheken mit allen Dateien entfernt.
        Was übrig bleibt (Wertung und Spielanzahl ohne Name oder E-Mail), wird wie ein ungenutztes
        Gastprofil nach {GUEST_RETENTION_DAYS} Tagen gelöscht. Ein Gastprofil kannst du auch
        loswerden, indem du das Cookie löschst; es verfällt dann nach {GUEST_RETENTION_DAYS} Tagen.
      </p>

      <h2>15. Deine Rechte</h2>
      {/* TODO(owner): name the competent supervisory authority (the data protection authority of
          the German state you live in) with its address/website. */}
      <p>Du hast das Recht auf</p>
      <ul>
        <li>Auskunft über deine Daten (Art. 15 DSGVO),</li>
        <li>Berichtigung (Art. 16 DSGVO),</li>
        <li>Löschung (Art. 17 DSGVO),</li>
        <li>Einschränkung der Verarbeitung (Art. 18 DSGVO),</li>
        <li>Datenübertragbarkeit (Art. 20 DSGVO),</li>
        <li>
          <strong>Widerspruch</strong> gegen Verarbeitungen, die auf unserem berechtigten Interesse
          beruhen (Art. 21 DSGVO),
        </li>
        <li>
          Beschwerde bei einer Datenschutz-Aufsichtsbehörde (Art. 77 DSGVO), zum Beispiel in dem
          Bundesland oder EU-Staat, in dem du wohnst.
        </li>
      </ul>
      <p>
        Schreib dafür einfach an die E-Mail-Adresse unter 1. Bei Gastprofilen können wir dich nur
        zuordnen, wenn du uns sagst, unter welchem Namen und wann du gespielt hast.
      </p>
    </div>
  );
}

function English({ legal }: { legal: LegalInfo | null | undefined }) {
  return (
    <div className="flex flex-col gap-3" lang="en">
      <p className="text-zinc-500">
        Last updated: {PRIVACY_STAND.en}. This is a translation; the German version is the binding
        one.
      </p>
      <p>
        Voicejack is a free party game run by one person as a hobby project. There are{' '}
        <strong>no ads, no analytics and no tracking</strong>, and no scripts, fonts or images from
        other servers. This page says which data still comes up, what for, and for how long.
      </p>

      <h2>1. Controller</h2>
      <Controller legal={legal} />
      <p>
        More in the <Link to="/impressum">Impressum</Link>.
      </p>

      <h2>2. Hosting</h2>
      <p>
        Voicejack runs on a server of Hetzner Online GmbH, Industriestr. 25, 91710 Gunzenhausen,
        Germany, in its <strong>Helsinki, Finland (EU)</strong> data centre. Hetzner processes the
        data on our behalf (Art. 28 GDPR).
      </p>

      <h2>3. Server logs</h2>
      <p>
        For every request the web server (nginx) stores: IP address, date and time, the requested
        address, status code, bytes sent, the referring page and the browser identifier (user
        agent). The logs are rotated daily and deleted after {NGINX_LOG_DAYS} days.
      </p>
      <p>
        The app itself logs requests only with method, path (without parameters), status code and
        time, plus errors, <strong>without IP address</strong>, user agent or other headers. This
        log is capped at 30 MB; older entries are overwritten. For rate limits and blocks after
        reports (abuse protection) the IP address is held briefly in memory and not stored.
      </p>
      <p>
        Purpose: operation, debugging and fending off attacks. Legal basis: Art. 6(1)(f) GDPR
        (legitimate interest in a secure, working service).
      </p>

      <h2>4. Cookie and browser storage</h2>
      <p>
        We set exactly <strong>one cookie</strong>: <code>vj_session</code>. It holds a random id
        that links your browser to a guest profile on your first visit (or to your account later).
        It is HttpOnly, SameSite=Lax, lasts {SESSION_DAYS} days and is extended while you use it.
        The game does not work without it (rooms, reconnecting, sign-in), so it is strictly
        necessary (§ 25(2) no. 2 TDDDG); no consent and no cookie banner are needed.
      </p>
      <p>The site also stores in your browser (localStorage / sessionStorage):</p>
      <ul>
        <li>
          <code>dub.name</code>: the player name you used last, to pre-fill it.
        </li>
        <li>
          <code>dub.token.&lt;ROOMCODE&gt;</code>: a random room token so a reload brings you back
          into the same room. It is sent to our server for that.
        </li>
        <li>
          <code>vj.sfx</code>: whether game sounds are on or off.
        </li>
        <li>
          <code>vj.supportShown</code> (session only): whether the support note was shown already.
        </li>
      </ul>
      <p>None of this is used to follow you across other websites.</p>

      <h2>5. Guest profile and account</h2>
      <p>
        Every browser automatically gets a <strong>guest profile</strong>: a random id, the display
        name used last, Elo rating, number of public games, and when it was created and last used.
        Guest profiles unused for {GUEST_RETENTION_DAYS} days are deleted automatically.
      </p>
      <p>
        An optional <strong>account</strong> adds your email address; the guest's rating and games
        are kept. Your display name is visible to the other players in the same room; your avatar is
        generated in the browser from the name. Legal basis: Art. 6(1)(b) GDPR (providing the game
        you want to use).
      </p>

      <h2>6. Sign-in by email link</h2>
      <p>
        To sign in we email you a link. For that we store your address, a hash of the link and the
        time; the link is valid for 15 minutes and the entry is deleted shortly after. The mail is
        sent by our own mail server on the same machine through the mail provider goneo Internet
        GmbH (Germany). The server's mail log contains the recipient address and is deleted after
        about {MAIL_LOG_WEEKS} weeks.
      </p>

      <h2>7. Playing: rooms and recordings</h2>
      <p>
        Room data (names, points, votes) only lives in memory while the room exists. The microphone
        is only used after you allow it in your browser. Your <strong>dub recordings</strong> are
        uploaded to our server and delivered to the other players in the room so everyone can hear
        and rate them. They are deleted when the room closes (at the latest 3 hours after it was
        created, or 10 minutes after the last player left) and on every server restart. They are not
        in backups.
      </p>
      <p>
        <strong>"Save video"</strong> renders the video entirely in your browser; it is not
        uploaded. Legal basis: Art. 6(1)(b) GDPR.
      </p>

      <h2>8. Voice chat (WebRTC)</h2>
      <p>
        Voice chat runs <strong>directly between the players' browsers</strong> (peer-to-peer).
        Voice does not pass through our server and is not recorded; our server only helps set up the
        connection. In private rooms your browser opens a direct connection to every other player,
        even while you are muted. In <strong>public games</strong> ("Join a random game") voice is
        off until you tap "Tap to talk" or "Tap to listen"; a connection is only made between two
        players who both opted in, and it is closed once you switch both off again.{' '}
        <strong>
          Over such a connection your IP address is technically visible to that player.
        </strong>
      </p>
      <p>
        To find a connection path, your browser asks Google LLC's (USA) STUN server{' '}
        <code>{STUN_HOST}</code> for your public IP address. Google receives your IP address and
        port, but no voice and no game data. This is a transfer to a third country (USA); it relies
        on the European Commission's adequacy decision for the EU-US Data Privacy Framework (Art. 45
        GDPR), under which Google LLC is certified. Legal basis: Art. 6(1)(b) GDPR (voice chat as
        part of the game).
      </p>

      <h2>9. Public games and reports</h2>
      <p>
        For "random game" the queue (player name, waiting time) is only kept in memory. When you
        report someone (a player, a message or a clip), we store the time, room code, the names and
        profile ids of you and the reported person, your reason, and where relevant the reported
        message or the clip id. Reports are kept for moderation, even after the message itself was
        deleted. Legal basis: Art. 6(1)(f) GDPR (protecting players, enforcing the rules).
      </p>

      <h2>10. Friends and direct messages</h2>
      <p>
        Accounts only. We store friendships and friend requests, blocks and your direct messages
        (text, time, read). Friends see whether you are online or in a game. Direct messages are
        deleted automatically after {DM_RETENTION_DAYS} days. A reported message stays quoted in the
        report (see 9). Legal basis: Art. 6(1)(b) GDPR.
      </p>

      <h2>11. Your own clips</h2>
      <p>
        Signed-in players can upload their own video clips. We store the video (converted on our
        server), title and credit, your confirmation that you hold the rights, and upload times for
        the upload limits. The clips are only visible to you and to players in rooms that use your
        library. They stay until you delete them or your account, or we remove them after a report
        (see <Link to="/takedown">report content</Link>).
      </p>

      <h2>12. Backups</h2>
      <p>
        The database (profiles, accounts, friends, messages, reports) and uploaded clips are backed
        up regularly. Deleted data may therefore remain in the backups for as long as those are
        kept.
      </p>

      <h2>13. Support (Liberapay)</h2>
      <p>
        The "Chip in" / "Support" button is a plain link to liberapay.com. Nothing from Liberapay is
        loaded on Voicejack; Liberapay's privacy policy only applies once you open the link.
      </p>

      <h2>14. Deleting your account</h2>
      <p>
        In the account menu (top right), <strong>"Delete account"</strong>. This immediately removes
        your email address and name, ends all sessions, deletes friendships, blocks and direct
        messages, and removes your own clip libraries with all their files. What is left (rating and
        game count, without name or email) is deleted like an unused guest profile after{' '}
        {GUEST_RETENTION_DAYS} days. To get rid of a guest profile, delete the cookie; the profile
        then expires after {GUEST_RETENTION_DAYS} days.
      </p>

      <h2>15. Your rights</h2>
      <p>You have the right to</p>
      <ul>
        <li>access your data (Art. 15 GDPR),</li>
        <li>rectification (Art. 16 GDPR),</li>
        <li>erasure (Art. 17 GDPR),</li>
        <li>restriction of processing (Art. 18 GDPR),</li>
        <li>data portability (Art. 20 GDPR),</li>
        <li>
          <strong>object</strong> to processing based on our legitimate interest (Art. 21 GDPR),
        </li>
        <li>
          lodge a complaint with a data protection supervisory authority (Art. 77 GDPR), for example
          in the state or EU country where you live.
        </li>
      </ul>
      <p>
        Just write to the email address in section 1. For guest profiles we can only find your data
        if you tell us under which name and when you played.
      </p>
    </div>
  );
}
