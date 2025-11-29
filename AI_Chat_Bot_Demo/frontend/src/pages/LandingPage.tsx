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
      <section className="hero">
        <h1>AI Booking Assistant for Local Businesses</h1>
        <p>
          Turn your website, WhatsApp, Messenger, and Instagram into a smart
          assistant that answers questions and books appointments in your Google
          Calendar.
        </p>
        <div className="hero-actions">
          <Link to="/register" className="btn-primary">
            Get started
          </Link>
          <Link to="/login" className="btn-secondary">
            Login
          </Link>
        </div>
      </section>

      <section className="features">
        <h2>Why this platform?</h2>
        <div className="feature-grid">
          <div className="feature-card">
            <h3>Multi-channel</h3>
            <p>Web widget, WhatsApp, Facebook Messenger, and Instagram DM.</p>
          </div>
          <div className="feature-card">
            <h3>Knowledge from your content</h3>
            <p>
              We crawl your website and ingest your PDFs so the assistant knows
              your business inside out.
            </p>
          </div>
          <div className="feature-card">
            <h3>Real bookings</h3>
            <p>
              Confirmed appointments go straight into your Google Calendar with
              date, time, and client details.
            </p>
          </div>
        </div>
      </section>

      <section className="landing-footer">
        <p>
          Just want to see a demo? Ask for a{" "}
          <code>/demo/&lt;your-business&gt;</code> link.
        </p>
      </section>
    </div>
  );
};

export default LandingPage;
