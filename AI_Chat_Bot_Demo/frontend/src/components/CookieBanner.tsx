// src/components/CookieBanner.tsx
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const COOKIE_KEY = "cookieConsent"; // "accepted" | "rejected"

const CookieBanner: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(COOKIE_KEY);
      if (!stored) {
        setVisible(true);
      }
    } catch {
      // se localStorage non è disponibile, mostro comunque il banner
      setVisible(true);
    }
  }, []);

  const handleChoice = (value: "accepted" | "rejected") => {
    try {
      localStorage.setItem(COOKIE_KEY, value);
    } catch {
      // ignore
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="cookie-banner">
      <div className="lp-container cookie-banner-inner">
        <div className="cookie-banner-text">
          <h2 className="cookie-banner-title">Usiamo cookie e tecnologie simili</h2>
          <p className="cookie-banner-body">
            Utilizziamo cookie tecnici e, previo tuo consenso, cookie analitici e di
            profilazione per migliorare l&apos;esperienza e misurare l&apos;utilizzo della
            piattaforma. Puoi modificare la tua scelta in qualsiasi momento.
            Consulta la nostra{" "}
            <Link to="/policy" className="cookie-banner-link">
              Privacy &amp; Policy
            </Link>{" "}
            per maggiori dettagli.
          </p>
        </div>

        <div className="cookie-banner-actions">
          <button
            type="button"
            className="cookie-btn cookie-btn-secondary"
            onClick={() => handleChoice("rejected")}
          >
            Rifiuta
          </button>
          <button
            type="button"
            className="cookie-btn cookie-btn-primary"
            onClick={() => handleChoice("accepted")}
          >
            Accetta
          </button>
        </div>
      </div>
    </div>
  );
};

export default CookieBanner;
