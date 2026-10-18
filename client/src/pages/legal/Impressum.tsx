import { Link } from 'react-router';
import { LegalLayout, Loading, NotConfigured } from './LegalLayout';
import { lines, useLegal } from './useLegal';

/** §5 DDG / §18 MStV. The details come from the server's `legal.json`, never from the repo. */
export default function Impressum() {
  const legal = useLegal();
  return (
    <LegalLayout title="Impressum" eyebrow="Legal notice" testId="legal-impressum">
      {legal === undefined ? (
        <Loading />
      ) : legal === null ? (
        <NotConfigured />
      ) : (
        <>
          <section>
            <h2>Angaben gemäß § 5 DDG</h2>
            <address className="not-italic" data-testid="legal-operator">
              <strong>{legal.name}</strong>
              {lines(legal.address).map((l) => (
                <span key={l} className="block">
                  {l}
                </span>
              ))}
            </address>
          </section>
          <section>
            <h2>Kontakt</h2>
            <p>
              E-Mail: <a href={`mailto:${legal.email}`}>{legal.email}</a>
              {legal.phone && (
                <>
                  <br />
                  Telefon: <a href={`tel:${legal.phone.replace(/[^\d+]/g, '')}`}>{legal.phone}</a>
                </>
              )}
            </p>
          </section>
          {legal.vatId && (
            <section>
              <h2>Umsatzsteuer-ID</h2>
              <p>Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: {legal.vatId}</p>
            </section>
          )}
          {legal.responsibleForContent && (
            <section>
              <h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
              <p>
                {lines(legal.responsibleForContent).map((l) => (
                  <span key={l} className="block">
                    {l}
                  </span>
                ))}
              </p>
            </section>
          )}
        </>
      )}
      <section>
        <h2>Mehr</h2>
        <p>
          <Link to="/datenschutz">Datenschutzerklärung / Privacy policy</Link>
          <br />
          <Link to="/takedown">Inhalte melden / Report content (notice &amp; takedown)</Link>
        </p>
        <p className="text-zinc-500">
          English: this page is the legal notice required by German law (§ 5 DDG). It names the
          person operating Voicejack and how to reach them.
        </p>
      </section>
    </LegalLayout>
  );
}
