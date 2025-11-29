// src/pages/LandingPage.tsx
import React from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";

const LandingPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const bot = searchParams.get("bot");

  if (bot) {
    // Preserve demo behavior: /?bot=slug → /demo/:slug
    return <Navigate to={`/demo/${bot}`} replace />;
  }

  return (
    <div className="landing-page">
      {/* HERO */}
      <section className="lp-hero">
        <div className="lp-container lp-hero-inner">
          <h1 className="lp-hero-title">
            Perché scegliere la nostra piattaforma di Intelligenza Artificiale?
          </h1>
          <p className="lp-hero-subtitle">
            Trasforma il tuo business con un assistente AI che lavora per te
            24/7, risponde ai clienti in modo immediato e gestisce per davvero
            le attività operative che ti fanno perdere tempo.
          </p>
          <div className="lp-hero-actions">
            <Link to="/register" className="lp-btn lp-btn-primary">
              Inizia ora
            </Link>
            <Link to="/login" className="lp-btn lp-btn-secondary">
              Accedi
            </Link>
          </div>
          <p className="lp-hero-note">
            Un assistente digitale sempre disponibile su sito, canali social e
            messaggistica, in grado di rispondere alle domande dei clienti e
            gestire i flussi ripetitivi al posto tuo.
          </p>
        </div>
      </section>

      {/* SEZIONE INTRO */}
      <section className="lp-section">
        <div className="lp-container lp-grid-2">
          <div>
            <h2 className="lp-section-title">
              Un&apos;assistenza continua, precisa e realmente utile
            </h2>
          </div>
          <div className="lp-section-text">
            <p>
              La nostra piattaforma è pensata per semplificare il lavoro delle
              aziende, aumentare le conversioni e offrire ai clienti un
              canale di comunicazione moderno, fluido e immediato.
            </p>
            <p>
              Grazie a un sistema avanzato di automazione e comprensione dei
              contenuti, il tuo business può finalmente garantire un supporto
              costante, coerente e di qualità, senza dover aumentare il carico
              di lavoro del team interno.
            </p>
            <p>
              Qui troverai nel dettaglio tutte le funzionalità che rendono il
              nostro assistente AI uno strumento davvero indispensabile per la
              tua attività.
            </p>
          </div>
        </div>
      </section>

      {/* SEZIONE MULTICANALE */}
      <section className="lp-section lp-section-alt">
        <div className="lp-container">
          <div className="lp-grid-2">
            <div>
              <h2 className="lp-section-title">
                Multicanale: presente dove sono i tuoi clienti
              </h2>
            </div>
            <div className="lp-section-text">
              <p>
                Le persone si aspettano risposte rapide, senza dover cambiare
                canale o aspettare ore. Per questo l&apos;assistente AI si
                integra con gli strumenti che i tuoi clienti usano ogni giorno.
              </p>
              <p>
                In questo modo il tuo brand è sempre raggiungibile e pronto a
                interagire, migliorando l&apos;esperienza utente e aumentando le
                opportunità di conversione.
              </p>
            </div>
          </div>

          <div className="lp-channel-grid">
            <div className="lp-card">
              <h3 className="lp-card-title">Web Widget</h3>
              <p className="lp-card-text">
                Integrato direttamente nel tuo sito, sempre visibile e attivo
                24/7 per rispondere alle domande e guidare gli utenti all&apos;azione.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">WhatsApp</h3>
              <p className="lp-card-text">
                Il canale di messaggistica più utilizzato: perfetto per
                assistenza, richieste rapide e prenotazioni immediate.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Facebook Messenger</h3>
              <p className="lp-card-text">
                Ideale per seguire gli utenti che arrivano dalle tue campagne e
                dai contenuti social, senza farti perdere nessuna conversazione.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Instagram Direct</h3>
              <p className="lp-card-text">
                Perfetto per intercettare domande e richieste che nascono da
                post, reel e storie, trasformandole in contatti e opportunità.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* SEZIONE CONOSCENZA CONTENUTI */}
      <section className="lp-section">
        <div className="lp-container lp-grid-2">
          <div>
            <h2 className="lp-section-title">
              Conoscenza profonda dei tuoi contenuti
            </h2>
          </div>
          <div className="lp-section-text">
            <p>
              L&apos;assistente non si limita a generare risposte generiche:
              impara davvero dal tuo materiale e da ciò che comunichi online.
            </p>
            <p>
              Grazie a un sistema avanzato di crawling e analisi, la piattaforma:
            </p>
            <ul className="lp-list">
              <li>naviga autonomamente il tuo sito web,</li>
              <li>legge e comprende i contenuti dei tuoi PDF,</li>
              <li>
                elabora testi, FAQ, guide, articoli e documentazione tecnica,
              </li>
              <li>
                organizza tutte le informazioni in una base di conoscenza chiara
                e coerente.
              </li>
            </ul>
            <p>
              In questo modo l&apos;AI conosce a fondo il tuo business: prodotti,
              servizi, processi interni, terminologia specifica e punti di forza.
              Il risultato sono risposte sempre aggiornate, precise e in linea
              con l&apos;identità del tuo brand.
            </p>
            <p>
              Non servono testi ad hoc: è sufficiente utilizzare ciò che hai
              già a disposizione, e l&apos;assistente farà il resto.
            </p>
          </div>
        </div>
      </section>

      {/* SEZIONE PRENOTAZIONI */}
      <section className="lp-section lp-section-alt">
        <div className="lp-container lp-grid-2 lp-grid-reverse">
          <div className="lp-section-image">
            <div className="lp-image-placeholder">
              <span>Anteprima integrazione con Google Calendar</span>
            </div>
          </div>
          <div>
            <h2 className="lp-section-title">
              Prenotazioni reali e confermate, direttamente nel tuo Google
              Calendar
            </h2>
            <div className="lp-section-text">
              <p>
                L&apos;assistente non è solo un supporto informativo, ma un vero
                collaboratore operativo. Tra le funzioni più apprezzate c&apos;è
                la gestione completa delle prenotazioni.
              </p>
              <p>Ecco cosa può fare in autonomia:</p>
              <ul className="lp-list">
                <li>propone date e fasce orarie disponibili,</li>
                <li>raccoglie i dati del cliente (nome, contatto, richiesta),</li>
                <li>conferma l&apos;appuntamento in tempo reale,</li>
                <li>
                  inserisce l&apos;evento nel tuo Google Calendar con tutti i
                  dettagli.
                </li>
              </ul>
              <p>
                Niente più messaggi sparsi, controlli incrociati o appuntamenti
                trascritti a mano: il flusso è semplice, automatizzato e riduce
                al minimo errori e perdite di tempo.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* SEZIONE CRESCITA E CASI D'USO */}
      <section className="lp-section">
        <div className="lp-container lp-grid-2">
          <div>
            <h2 className="lp-section-title">
              Un assistente che cresce con la tua azienda
            </h2>
          </div>
          <div className="lp-section-text">
            <p>
              Ogni interazione, ogni nuovo documento e ogni aggiornamento del
              tuo sito contribuiscono a migliorare la qualità delle risposte
              dell&apos;AI. La piattaforma evolve insieme al tuo business.
            </p>
            <p>Puoi utilizzarlo, ad esempio, per:</p>
            <div className="lp-pill-list">
              <span className="lp-pill">Assistenza clienti</span>
              <span className="lp-pill">Prenotazioni e appuntamenti</span>
              <span className="lp-pill">Risposte ai contatti social</span>
              <span className="lp-pill">Lead generation</span>
              <span className="lp-pill">Supporto tecnico</span>
              <span className="lp-pill">Gestione delle informazioni</span>
            </div>
            <p>
              È come avere un assistente digitale sempre disponibile, capace di
              rispondere a domande semplici e complesse e di occuparsi delle
              attività più ripetitive al posto tuo.
            </p>
          </div>
        </div>
      </section>

      {/* SEZIONE BENEFICI */}
      <section className="lp-section lp-section-alt">
        <div className="lp-container">
          <h2 className="lp-section-title lp-center">
            Perché le aziende che lo provano non tornano indietro
          </h2>
          <div className="lp-benefit-grid">
            <div className="lp-card">
              <h3 className="lp-card-title">Tempi di risposta ridotti</h3>
              <p className="lp-card-text">
                Migliori la soddisfazione dei clienti grazie a risposte rapide e
                consistenti, in qualsiasi momento della giornata.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Più contatti e prenotazioni</h3>
              <p className="lp-card-text">
                La presenza multicanale aumenta i punti di contatto e ti
                permette di trasformare più conversazioni in appuntamenti o
                opportunità commerciali.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Automazione intelligente</h3>
              <p className="lp-card-text">
                Delegando all&apos;AI i compiti ripetitivi, il tuo team può
                concentrarsi sulle attività strategiche che generano maggior
                valore.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Coerenza con il brand</h3>
              <p className="lp-card-text">
                Le risposte sono in linea con le informazioni, il tono di voce e
                le linee guida della tua azienda, senza improvvisazioni.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA FINALE */}
      <section className="lp-section lp-cta-final">
        <div className="lp-container lp-cta-inner">
          <h2 className="lp-section-title">Porta il tuo business nel futuro</h2>
          <p className="lp-section-lead">
            In un mercato sempre più competitivo, la qualità e la velocità della
            comunicazione fanno la differenza. Con il nostro assistente AI puoi
            offrire un&apos;esperienza moderna, professionale e completamente
            automatizzata.
          </p>
          <div className="lp-hero-actions">
            <Link to="/register" className="lp-btn lp-btn-primary">
              Inizia ora
            </Link>
            <Link to="/login" className="lp-btn lp-btn-secondary">
              Accedi alla tua area
            </Link>
          </div>
          <p className="lp-cta-note">
            Vuoi solo vedere un esempio? Puoi richiedere un link del tipo{" "}
            <code>/demo/&lt;la-tua-attività&gt;</code> per provare un bot in
            azione.
          </p>
        </div>
      </section>
    </div>
  );
};

export default LandingPage;
