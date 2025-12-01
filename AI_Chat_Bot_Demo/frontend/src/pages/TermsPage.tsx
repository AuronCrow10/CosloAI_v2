// src/pages/TermsPage.tsx
import React from "react";
import SiteFooter from "../components/SiteFooter";

const TermsPage: React.FC = () => {
  return (
    <div className="policy-page">
      <div className="lp-container policy-container">
        {/* Header */}
        <header className="policy-header">
          <p className="policy-kicker">Legal</p>
          <h1 className="lp-section-title">
            Termini e Condizioni d&apos;Uso
          </h1>
          <p className="lp-text policy-intro">
            I presenti Termini e Condizioni regolano l&apos;utilizzo della
            piattaforma SaaS multi-tenant che collega i tuoi canali di
            comunicazione (web, WhatsApp, Facebook, Instagram e altri) ad un
            assistente di Intelligenza Artificiale e ai servizi di
            pianificazione (es. Google Calendar). Utilizzando il servizio,
            accetti integralmente i presenti Termini.
          </p>
        </header>

        <div className="policy-grid">
          {/* 1. Definizioni */}
          <section className="policy-section">
            <h2 className="policy-subtitle">1. Definizioni</h2>
            <ul className="policy-list">
              <li>
                <strong>&quot;Piattaforma&quot;</strong>: l&apos;applicazione
                SaaS multi-tenant messa a disposizione dal Fornitore.
              </li>
              <li>
                <strong>&quot;Cliente&quot;</strong>: la persona fisica o
                giuridica che crea un account sulla Piattaforma e ne utilizza i
                servizi per il proprio business.
              </li>
              <li>
                <strong>&quot;Utenti finali&quot;</strong>: i clienti, lead o
                visitatori che interagiscono con i bot/assistenti del Cliente
                tramite i vari canali.
              </li>
              <li>
                <strong>&quot;Contenuti del Cliente&quot;</strong>: testi,
                file, dati, messaggi, conversazioni, impostazioni e qualsiasi
                informazione caricata o configurata dal Cliente sulla
                Piattaforma.
              </li>
              <li>
                <strong>&quot;Servizi di Terze Parti&quot;</strong>: servizi
                esterni integrati, come Meta (WhatsApp, Facebook, Instagram),
                Google (Google Calendar), provider AI, servizi di pagamento,
                hosting e simili.
              </li>
            </ul>
          </section>

          {/* 2. Ambito di applicazione */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              2. Ambito di applicazione del servizio
            </h2>
            <p className="lp-text">
              La Piattaforma consente di creare e gestire assistenti AI
              conversazionali per diversi canali, configurare flussi di
              automazione, integrare servizi esterni (es. Google Calendar) e
              visualizzare dati e conversazioni. Il servizio è fornito in
              modalità &quot;as-a-service&quot;, tramite accesso via web, e
              può essere aggiornato, modificato o ampliato nel tempo.
            </p>
            <p className="lp-text">
              I presenti Termini si applicano a tutti i Clienti e agli utenti
              autorizzati dei relativi account. Se accedi alla Piattaforma per
              conto di una società o ente, dichiari di avere l&apos;autorità
              necessaria a vincolare tale organizzazione ai presenti Termini.
            </p>
          </section>

          {/* 3. Account e registrazione */}
          <section className="policy-section">
            <h2 className="policy-subtitle">3. Account, registrazione e sicurezza</h2>
            <ul className="policy-list">
              <li>
                Per utilizzare la Piattaforma è necessario creare un account
                fornendo informazioni accurate, complete e aggiornate.
              </li>
              <li>
                Il Cliente è responsabile di tutte le attività svolte tramite il
                proprio account e si impegna a mantenere riservate credenziali
                di accesso e chiavi/API collegate.
              </li>
              <li>
                Il Cliente si impegna a notificare tempestivamente al Fornitore
                qualsiasi uso non autorizzato dell&apos;account o sospetto di
                violazione di sicurezza.
              </li>
              <li>
                Il Fornitore può sospendere o chiudere account che risultino
                in violazione dei presenti Termini o utilizzati in modo
                fraudolento o illecito.
              </li>
            </ul>
          </section>

          {/* 4. Piani, pagamenti, rinnovi */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              4. Piani, abbonamenti e modalità di pagamento
            </h2>
            <ul className="policy-list">
              <li>
                L&apos;utilizzo della Piattaforma può essere soggetto a piani
                gratuiti, prove a tempo limitato e/o abbonamenti a pagamento,
                come indicato sul sito o nel pannello di amministrazione.
              </li>
              <li>
                I canoni sono normalmente fatturati in modalità ricorrente
                (mensile o annuale) tramite i provider di pagamento indicati
                (es. Stripe). Il Cliente autorizza l&apos;addebito automatico
                finché l&apos;abbonamento rimane attivo.
              </li>
              <li>
                Salvo diversa indicazione, le tariffe sono al netto di imposte,
                tasse o altri oneri applicabili, che restano a carico del
                Cliente.
              </li>
              <li>
                In caso di mancato pagamento, il Fornitore può sospendere o
                limitare l&apos;accesso alla Piattaforma fino alla regolarizzazione
                della posizione.
              </li>
            </ul>
          </section>

          {/* 5. Uso consentito e contenuti */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              5. Uso consentito e responsabilità sui contenuti
            </h2>
            <ul className="policy-list">
              <li>
                Il Cliente è l&apos;unico responsabile dei Contenuti del Cliente
                e delle interazioni con gli Utenti finali. Il Fornitore non
                controlla preventivamente i contenuti generati o configurati.
              </li>
              <li>
                È vietato utilizzare la Piattaforma per attività illegali,
                abusive, diffamatorie, discriminatorie, fraudolente, per spam o
                per la distribuzione di malware, phishing o contenuti che
                violino diritti di terzi.
              </li>
              <li>
                Il Cliente garantisce di avere i diritti e le basi giuridiche
                per trattare i dati personali degli Utenti finali e per
                collegare alla Piattaforma gli account e i canali utilizzati.
              </li>
              <li>
                Il Cliente si impegna a fornire agli Utenti finali le proprie
                informative privacy e ogni comunicazione prevista dalle norme
                applicabili (incluso, se del caso, il GDPR).
              </li>
            </ul>
          </section>

          {/* 6. Dati, privacy e multi-tenant */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              6. Dati, privacy e architettura multi-tenant
            </h2>
            <p className="lp-text">
              La Piattaforma è progettata come sistema multi-tenant: i dati
              relativi a ciascun Cliente sono logicamente separati dagli altri
              tenant e accessibili solo al Cliente stesso e al personale
              autorizzato del Fornitore per finalità di erogazione del
              servizio, supporto e sicurezza.
            </p>
            <p className="lp-text">
              Il trattamento dei dati personali è descritto nella{" "}
              <strong>Privacy &amp; Data Policy</strong>, che costituisce parte
              integrante dei presenti Termini. Utilizzando la Piattaforma, il
              Cliente dichiara di aver letto e accettato anche tale informativa.
            </p>
          </section>

          {/* 7. AI & limitazioni */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              7. Utilizzo dell&apos;Intelligenza Artificiale e limitazioni
            </h2>
            <ul className="policy-list">
              <li>
                Le risposte fornite dagli assistenti AI sono generate in modo
                automatico sulla base dei prompt, delle configurazioni e dei
                contenuti forniti dal Cliente, nonché dei modelli AI di terze
                parti integrati.
              </li>
              <li>
                Il Cliente riconosce che l&apos;AI può occasionalmente produrre
                contenuti inesatti, incompleti o non aggiornati. Il servizio è
                fornito sulla base del &quot;best effort&quot; tecnologico ma
                non sostituisce consulenze professionali (es. legali, mediche,
                fiscali).
              </li>
              <li>
                Il Cliente è responsabile di verificare la correttezza delle
                informazioni fornite dall&apos;assistente ai propri Utenti
                finali, soprattutto in ambiti regolamentati o critici.
              </li>
              <li>
                Il Fornitore può utilizzare in forma aggregata e anonima i dati
                di utilizzo (non riconducibili a persone fisiche) per migliorare
                prestazioni, sicurezza e funzionalità della Piattaforma.
              </li>
            </ul>
          </section>

          {/* 8. Servizi di terze parti */}
          <section className="policy-section">
            <h2 className="policy-subtitle">8. Servizi e integrazioni di terze parti</h2>
            <ul className="policy-list">
              <li>
                La Piattaforma si integra con Servizi di Terze Parti (es.
                OpenAI, Google, Meta, provider di pagamento e hosting). Tali
                servizi sono soggetti ai rispettivi termini e condizioni, che il
                Cliente è tenuto a leggere e rispettare.
              </li>
              <li>
                Il Fornitore non è responsabile per interruzioni, modifiche o
                limitazioni imposte dai Servizi di Terze Parti, né per
                eventuali danni derivanti da tali servizi esterni.
              </li>
              <li>
                La disponibilità di alcune funzionalità può dipendere dal
                corretto funzionamento e dalle policy dei provider esterni.
              </li>
            </ul>
          </section>

          {/* 9. Disponibilità del servizio e supporto */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              9. Disponibilità, manutenzione e supporto
            </h2>
            <ul className="policy-list">
              <li>
                Il Fornitore si impegna a mantenere la Piattaforma
                ragionevolmente disponibile e performante, compatibilmente con
                attività di manutenzione ordinaria e straordinaria.
              </li>
              <li>
                Il Fornitore può effettuare aggiornamenti, cambiamenti
                infrastrutturali o modifiche alle funzionalità, informando il
                Cliente in caso di impatti rilevanti.
              </li>
              <li>
                Il livello di supporto (tempi di risposta, canali disponibili)
                può variare in base al piano sottoscritto.
              </li>
            </ul>
          </section>

          {/* 10. Diritti di proprietà intellettuale */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              10. Proprietà intellettuale
            </h2>
            <ul className="policy-list">
              <li>
                Tutti i diritti sulla Piattaforma, sul codice sorgente, sui
                design, sui marchi e sulla documentazione sono e restano di
                titolarità del Fornitore o dei suoi licenzianti.
              </li>
              <li>
                Il Cliente mantiene tutti i diritti sui propri Contenuti, nei
                limiti necessari all&apos;erogazione del servizio; il Cliente
                concede al Fornitore una licenza limitata all&apos;uso, copia,
                elaborazione e visualizzazione dei Contenuti del Cliente
                esclusivamente per fornire la Piattaforma.
              </li>
              <li>
                È vietato effettuare reverse engineering, decompilazione,
                copia non autorizzata, rivendita non concordata o creazione di
                servizi concorrenti basati sulla Piattaforma.
              </li>
            </ul>
          </section>

          {/* 11. Durata e recesso */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              11. Durata, sospensione e cessazione
            </h2>
            <ul className="policy-list">
              <li>
                L&apos;account rimane attivo finché il Cliente mantiene una
                sottoscrizione valida o un piano gratuito compatibile con le
                policy in vigore.
              </li>
              <li>
                Il Cliente può interrompere l&apos;abbonamento in qualsiasi
                momento, secondo le modalità indicate nella Piattaforma. Salvo
                diversa indicazione, i canoni già pagati non sono rimborsabili.
              </li>
              <li>
                Il Fornitore può sospendere o cessare l&apos;accesso alla
                Piattaforma in caso di violazioni gravi o ripetute dei presenti
                Termini, mancato pagamento o utilizzo illecito del servizio.
              </li>
              <li>
                In caso di cessazione, il Cliente può richiedere l&apos;export
                di alcuni dati, nei limiti delle funzionalità disponibili e per
                un periodo ragionevole dalla data di chiusura.
              </li>
            </ul>
          </section>

          {/* 12. Esclusioni di responsabilità */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              12. Esclusioni di garanzia e limitazione di responsabilità
            </h2>
            <ul className="policy-list">
              <li>
                La Piattaforma è fornita &quot;così com&apos;è&quot; e
                &quot;come disponibile&quot;. Nei limiti massimi consentiti
                dalla legge, il Fornitore esclude qualsiasi garanzia espressa o
                implicita (inclusa l&apos;idoneità ad uno scopo particolare).
              </li>
              <li>
                Fatto salvo il dolo o la colpa grave, la responsabilità totale
                del Fornitore nei confronti del Cliente per qualsiasi danno
                derivante dall&apos;uso della Piattaforma è limitata ad un
                importo non superiore alle somme effettivamente pagate dal
                Cliente nei dodici (12) mesi precedenti l&apos;evento dannoso.
              </li>
              <li>
                In nessun caso il Fornitore sarà responsabile per perdita di
                profitti, perdita di dati non dipendente da propria colpa grave,
                interruzione di business o danni indiretti, consequenziali o
                punitivi.
              </li>
            </ul>
          </section>

          {/* 13. Indennizzo */}
          <section className="policy-section">
            <h2 className="policy-subtitle">13. Manleva (Indennizzo)</h2>
            <p className="lp-text">
              Il Cliente si impegna a tenere indenne e manlevare il Fornitore e
              il suo personale da qualsiasi reclamo, danno, perdita o costo
              (incluse spese legali ragionevoli) derivante da:
            </p>
            <ul className="policy-list">
              <li>uso illecito o non conforme della Piattaforma;</li>
              <li>
                violazione dei presenti Termini o delle normative applicabili;
              </li>
              <li>
                violazione di diritti di terzi tramite i Contenuti del Cliente
                o le interazioni con gli Utenti finali.
              </li>
            </ul>
          </section>

          {/* 14. Modifiche ai Termini */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              14. Modifiche alla Piattaforma e ai Termini
            </h2>
            <p className="lp-text">
              Il Fornitore può aggiornare periodicamente la Piattaforma,
              introdurre nuove funzionalità o modificare/ritirare funzionalità
              esistenti. I presenti Termini possono essere aggiornati per
              riflettere cambiamenti tecnici, legali o di business. In caso di
              modifiche sostanziali, il Cliente verrà informato con un preavviso
              ragionevole tramite e-mail o notifiche in Piattaforma.
            </p>
            <p className="lp-text">
              L&apos;uso continuato della Piattaforma dopo la comunicazione
              delle modifiche implica l&apos;accettazione dei nuovi Termini.
            </p>
          </section>

          {/* 15. Legge applicabile */}
          <section className="policy-section">
            <h2 className="policy-subtitle">
              15. Legge applicabile e foro competente
            </h2>
            <p className="lp-text">
              Salvo diversa indicazione nel contratto specifico con il Cliente,
              i presenti Termini sono regolati dalla legge italiana. Qualsiasi
              controversia sarà devoluta in via esclusiva al Foro del luogo in
              cui il Fornitore ha la propria sede legale, fatti salvi i casi in
              cui la legge preveda un foro inderogabile a tutela del
              consumatore.
            </p>
          </section>

          {/* 16. Disposizioni finali */}
          <section className="policy-section">
            <h2 className="policy-subtitle">16. Disposizioni finali</h2>
            <ul className="policy-list">
              <li>
                L&apos;eventuale invalidità o inefficacia di una clausola non
                pregiudica la validità delle restanti disposizioni.
              </li>
              <li>
                Il mancato esercizio di un diritto da parte del Fornitore non
                costituisce rinuncia allo stesso.
              </li>
              <li>
                Il Cliente non può cedere o trasferire l&apos;account o i
                presenti Termini senza il consenso scritto del Fornitore; il
                Fornitore può cedere il contratto in caso di fusione, acquisizione
                o riorganizzazione societaria.
              </li>
            </ul>
            <p className="lp-text" style={{ marginTop: "0.8rem" }}>
              In caso di domande sui presenti Termini e Condizioni o sulle
              pratiche di trattamento dei dati, puoi contattarci tramite
              l&apos;indirizzo e-mail utilizzato in fase di registrazione.
            </p>
          </section>
        </div>
      </div>
      <SiteFooter />
    </div>
    
  );
};

export default TermsPage;
