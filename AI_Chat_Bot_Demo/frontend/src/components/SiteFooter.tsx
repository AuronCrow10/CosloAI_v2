// src/components/SiteFooter.tsx
import React from "react";
import { Link } from "react-router-dom";

const SiteFooter: React.FC = () => {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="lp-container site-footer-inner">
        {/* Colonna sinistra: brand + copy */}
        <div className="site-footer-left">
          <span className="site-footer-brand">Coslo - Assistente AI</span>
          <p className="site-footer-copy">
            © {year} Coslo. Tutti i diritti riservati.
          </p>
        </div>

        {/* Colonna centrale: link legali */}
        <nav className="site-footer-links" aria-label="Link legali">
          <Link to="/policy">Privacy &amp; Policy</Link>
          <Link to="/terms">Termini &amp; Condizioni</Link>
        </nav>

        {/* Colonna destra: social */}
        <div className="site-footer-social" aria-label="Social network">
          {/* Cambia gli href con i tuoi profili reali */}
          <a href="https://www.linkedin.com" target="_blank" rel="noreferrer" aria-label="LinkedIn">
            <span>in</span>
          </a>
          <a href="https://twitter.com" target="_blank" rel="noreferrer" aria-label="X / Twitter">
            <span>𝕏</span>
          </a>
          <a href="https://www.instagram.com" target="_blank" rel="noreferrer" aria-label="Instagram">
            <span>IG</span>
          </a>
        </div>
      </div>
    </footer>
  );
};

export default SiteFooter;
