// src/pages/LandingPage.tsx
import React from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import cosloHero from "../assets/coslo-hero.png";
import cosloAssist247 from "../assets/coslo-assist-247.png";
import cosloGrowth from "../assets/coslo-growth.png";
import SiteFooter from "../components/SiteFooter";

const LandingPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const bot = searchParams.get("bot");

  // Mantiene il comportamento originale: /?bot=slug → /demo/:slug
  if (bot) {
    return <Navigate to={`/demo/${bot}`} replace />;
  }

  return (
    <div className="landing-page">
      {/* HERO */}
      <section className="lp-hero">
        <div className="lp-container">
          <div className="lp-hero-grid">
            {/* Colonna testo */}
            <div className="lp-hero-content">
              <h1 className="lp-hero-title">
                Perché scegliere la nostra piattaforma di Intelligenza Artificiale?
              </h1>
              <p className="lp-hero-subtitle">
                Trasforma il tuo business con un assistente AI che lavora per te 24/7,
                risponde ai clienti in modo immediato e gestisce per davvero le attività
                operative che ti fanno perdere tempo.
              </p>
              <div className="lp-hero-cta">
                <Link to="/register" className="lp-btn lp-btn-primary">
                  Inizia ora
                </Link>
                <Link to="/login" className="lp-btn lp-btn-secondary">
                  Accedi
                </Link>
              </div>
              <p className="lp-hero-note">
                Un assistente digitale sempre disponibile su sito, canali social e
                messaggistica, in grado di rispondere alle domande dei clienti e gestire
                i flussi ripetitivi al posto tuo.
              </p>
            </div>

            {/* Colonna Coslo */}
            <div className="lp-hero-image">
              <div className="lp-hero-mascotte-frame">
                <div className="lp-hero-mascotte-glow" />
                <img
                  src={cosloHero}
                  alt="Coslo, il tuo assistente AI"
                  className="lp-hero-mascotte-img"
                />
                <div className="lp-hero-mascotte-badge">
                  <span className="lp-hero-mascotte-dot" />
                  Coslo · Assistente AI per il tuo business
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

{/* INTRO */}
<section className="lp-section">
  <div className="lp-container lp-intro-with-image">
    {/* 1. Titolo */}
    <div className="lp-intro-heading">
      <h2 className="lp-section-title">
        Un&apos;assistenza continua, precisa e realmente utile
      </h2>
    </div>

    {/* 2. Immagine Coslo 24/7 */}
    <div className="lp-intro-image">
      <div className="lp-intro-illustration-frame">
        <img
          src={cosloAssist247} // <-- usa qui il tuo import
          alt="Coslo sempre operativo 24/7 al computer"
        />
      </div>
    </div>

    {/* 3. Corpo testo */}
    <div className="lp-intro-body">
      <p className="lp-text">
        La nostra piattaforma è pensata per semplificare il lavoro delle aziende,
        aumentare le conversioni e offrire ai clienti un canale di comunicazione
        moderno, fluido e immediato.
      </p>
      <p className="lp-text">
        Grazie a un sistema avanzato di automazione e comprensione dei contenuti,
        il tuo business può finalmente garantire un supporto costante, coerente
        e di qualità, senza dover aumentare il carico di lavoro del team interno.
      </p>
      <p className="lp-text">
        Qui troverai nel dettaglio tutte le funzionalità che rendono il nostro
        assistente AI uno strumento davvero indispensabile per la tua attività.
      </p>
    </div>
  </div>
</section>

      {/* MULTICANALE */}
      <section className="lp-section lp-section-alt">
        <div className="lp-container">
          <div className="lp-grid-2 lp-section-intro">
            <div>
              <h2 className="lp-section-title">
                Multicanale: presente dove sono i tuoi clienti
              </h2>
            </div>
            <div>
              <p className="lp-text">
                Le persone si aspettano risposte rapide, senza dover cambiare canale o
                aspettare ore. Per questo l&apos;assistente AI si integra con gli strumenti
                che i tuoi clienti usano ogni giorno.
              </p>
              <p className="lp-text">
                In questo modo il tuo brand è sempre raggiungibile e pronto a interagire,
                migliorando l&apos;esperienza utente e aumentando le opportunità di conversione.
              </p>
            </div>
          </div>

          <div className="lp-grid-cards">
            <div className="lp-card">
              <h3 className="lp-card-title">Web Widget</h3>
              <p className="lp-card-text">
                Integrato direttamente nel tuo sito, sempre visibile e attivo 24/7
                per rispondere alle domande e guidare gli utenti all&apos;azione.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">WhatsApp</h3>
              <p className="lp-card-text">
                Il canale di messaggistica più utilizzato: perfetto per assistenza,
                richieste rapide e prenotazioni immediate.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Facebook Messenger</h3>
              <p className="lp-card-text">
                Ideale per seguire gli utenti che arrivano dalle tue campagne e dai
                contenuti social, senza farti perdere nessuna conversazione.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Instagram Direct</h3>
              <p className="lp-card-text">
                Perfetto per intercettare domande e richieste che nascono da post,
                reel e storie, trasformandole in contatti e opportunità.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CONOSCENZA CONTENUTI */}
      <section className="lp-section">
        <div className="lp-container lp-grid-2">
    <div className="lp-knowledge-left">
      <h2 className="lp-section-title">
        Conoscenza profonda dei tuoi contenuti
      </h2>

      <div className="lp-knowledge-card">
        <div className="lp-knowledge-avatar">
          <img
            src={cosloHero}  // usa lo stesso file del Coslo grande
            alt="Coslo che studia i tuoi contenuti"
          />
        </div>

        <div className="lp-knowledge-doc lp-knowledge-doc-1">
          <span className="lp-knowledge-doc-label">PDF</span>
        </div>
        <div className="lp-knowledge-doc lp-knowledge-doc-2">
          <span className="lp-knowledge-doc-label">Sito</span>
        </div>
        <div className="lp-knowledge-doc lp-knowledge-doc-3">
          <span className="lp-knowledge-doc-label">FAQ</span>
        </div>


      </div>
    </div>
          <div>
            <p className="lp-text">
              L&apos;assistente non si limita a generare risposte generiche: impara davvero
              dal tuo materiale e da ciò che comunichi online.
            </p>
            <p className="lp-text">
              Grazie a un sistema avanzato di crawling e analisi, la piattaforma:
            </p>
            <ul className="lp-list">
              <li>naviga autonomamente il tuo sito web,</li>
              <li>legge e comprende i contenuti dei tuoi PDF,</li>
              <li>elabora testi, FAQ, guide, articoli e documentazione tecnica,</li>
              <li>
                organizza tutte le informazioni in una base di conoscenza chiara e coerente.
              </li>
            </ul>
            <p className="lp-text">
              In questo modo l&apos;AI conosce a fondo il tuo business: prodotti, servizi,
              processi interni, terminologia specifica e punti di forza. Il risultato
              sono risposte sempre aggiornate, precise e in linea con l&apos;identità del brand.
            </p>
            <p className="lp-text">
              Non servono testi ad hoc: è sufficiente utilizzare ciò che hai già a
              disposizione, e l&apos;assistente farà il resto.
            </p>
          </div>
        </div>
      </section>

      {/* PRENOTAZIONI */}
      <section className="lp-section lp-section-alt">
        <div className="lp-container lp-grid-2 lp-section-calendar">
          <div>
            <h2 className="lp-section-title">
              Prenotazioni reali e confermate, direttamente nel tuo Google Calendar
            </h2>
            <p className="lp-text">
              L&apos;assistente non è solo un supporto informativo, ma un vero collaboratore
              operativo. Tra le funzioni più apprezzate c&apos;è la gestione completa delle
              prenotazioni.
            </p>
            <p className="lp-text">Ecco cosa può fare in autonomia:</p>
            <ul className="lp-list">
              <li>propone date e fasce orarie disponibili,</li>
              <li>raccoglie i dati del cliente (nome, contatto, richiesta),</li>
              <li>conferma l&apos;appuntamento in tempo reale,</li>
              <li>inserisce l&apos;evento nel tuo Google Calendar con tutti i dettagli.</li>
            </ul>
            <p className="lp-text">
              Niente più messaggi sparsi, controlli incrociati o appuntamenti trascritti
              a mano: il flusso è semplice, automatizzato e riduce al minimo errori e
              perdite di tempo.
            </p>
          </div>
          <div className="lp-calendar-mock">
            <div className="lp-calendar-header">Google Calendar</div>
            <div className="lp-calendar-body">
              <div className="lp-calendar-event">
                <div className="lp-event-time">14:00</div>
                <div className="lp-event-details">
                  <strong>Appuntamento Cliente</strong>
                  <span>Mario Rossi - Consulenza</span>
                </div>
              </div>
              <div className="lp-calendar-event">
                <div className="lp-event-time">16:30</div>
                <div className="lp-event-details">
                  <strong>Demo Prodotto</strong>
                  <span>Laura Bianchi - Presentazione</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CRESCITA */}
      <section className="lp-section">
        <div className="lp-container lp-growth-grid">
          {/* Coslo che costruisce i blocchi */}
          <div className="lp-growth-visual">
            <div className="lp-growth-card">
              <img
                src={cosloGrowth}
                alt="Coslo costruisce il tuo assistente AI"
                className="lp-growth-img"
              />
            </div>
          </div>

          {/* Testo + pillole */}
          <div>
            <h2 className="lp-section-title">
              Un assistente che cresce con la tua azienda
            </h2>
            <p className="lp-text">
              Ogni interazione, ogni nuovo documento e ogni aggiornamento del tuo sito
              contribuiscono a migliorare la qualità delle risposte dell&apos;AI.
              La piattaforma evolve insieme al tuo business.
            </p>
            <p className="lp-text">Puoi utilizzarlo, ad esempio, per:</p>
            <div className="lp-pills">
              <span className="lp-pill">Assistenza clienti</span>
              <span className="lp-pill">Prenotazioni e appuntamenti</span>
              <span className="lp-pill">Risposte ai contatti social</span>
              <span className="lp-pill">Lead generation</span>
              <span className="lp-pill">Supporto tecnico</span>
              <span className="lp-pill">Gestione delle informazioni</span>
            </div>
            <p className="lp-text">
              È come avere un assistente digitale sempre disponibile, capace di rispondere
              a domande semplici e complesse e di occuparsi delle attività più ripetitive
              al posto tuo.
            </p>
          </div>
        </div>
      </section>

      {/* BENEFICI */}
      <section className="lp-section lp-section-alt lp-section-benefits">
        <div className="lp-container">
          <h2 className="lp-section-title lp-centered">
            Perché le aziende che lo provano non tornano indietro
          </h2>
          <div className="lp-grid-cards lp-grid-3">
            <div className="lp-card">
              <h3 className="lp-card-title">Tempi di risposta ridotti</h3>
              <p className="lp-card-text">
                Migliori la soddisfazione dei clienti grazie a risposte rapide e consistenti,
                in qualsiasi momento della giornata.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Più contatti e prenotazioni</h3>
              <p className="lp-card-text">
                La presenza multicanale aumenta i punti di contatto e ti permette di
                trasformare più conversazioni in appuntamenti o opportunità commerciali.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Automazione intelligente</h3>
              <p className="lp-card-text">
                Delegando all&apos;AI i compiti ripetitivi, il tuo team può concentrarsi sulle
                attività strategiche che generano maggior valore.
              </p>
            </div>
            <div className="lp-card">
              <h3 className="lp-card-title">Coerenza con il brand</h3>
              <p className="lp-card-text">
                Le risposte sono in linea con le informazioni, il tono di voce e le linee
                guida della tua azienda, senza improvvisazioni.
              </p>
            </div>
          </div>
        </div>
      </section>


      {/* MINI COSLO CHAT */}
<section className="lp-section">
  <div className="lp-container lp-mini-coslo-grid">
    <div>
      <h2 className="lp-section-title">
        Coslo parla con i tuoi clienti, come un vero assistente
      </h2>
      <p className="lp-text">
        Ogni conversazione viene gestita con tono professionale e naturale:
        Coslo risponde alle domande frequenti, propone appuntamenti e raccoglie
        i dati importanti senza far perdere tempo al tuo team.
      </p>
      <p className="lp-text">
        Qui sotto vedi un esempio semplificato di come potrebbe apparire una
        conversazione tipica con i tuoi clienti.
      </p>
    </div>

    <div className="lp-mini-coslo-widget">
      <div className="lp-mini-coslo-avatar">
        {/* usa lo stesso file del Coslo grande, ma in piccolo */}
        <img
          src={cosloHero}
          alt="Coslo - Assistente AI"
        />
      </div>

      <div className="lp-mini-coslo-bubbles">
        <div className="lp-mini-coslo-bubble lp-mini-coslo-bubble-user">
          Ciao Coslo, posso spostare il mio appuntamento di domani?
        </div>
        <div className="lp-mini-coslo-bubble lp-mini-coslo-bubble-bot">
          Certo! Dimmi solo il giorno e l&apos;orario che preferisci
          e aggiorno subito il calendario.
        </div>
      </div>
    </div>
  </div>
</section>


      {/* CTA FINALE */}
      <section className="lp-section lp-cta-final">
        <div className="lp-container">
          <h2 className="lp-section-title lp-centered">
            Porta il tuo business nel futuro
          </h2>
          <p className="lp-text lp-centered lp-cta-text">
            In un mercato sempre più competitivo, la qualità e la velocità della
            comunicazione fanno la differenza. Con il nostro assistente AI puoi offrire
            un&apos;esperienza moderna, professionale e completamente automatizzata.
          </p>
          <div className="lp-hero-cta">
            <Link to="/register" className="lp-btn lp-btn-primary">
              Inizia ora
            </Link>
            <Link to="/login" className="lp-btn lp-btn-secondary">
              Accedi alla tua area
            </Link>
          </div>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
};

export default LandingPage;
