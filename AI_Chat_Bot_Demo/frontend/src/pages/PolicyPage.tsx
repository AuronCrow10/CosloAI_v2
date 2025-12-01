// src/pages/PolicyPage.tsx
import React from "react";
import SiteFooter from "../components/SiteFooter";

const PolicyPage: React.FC = () => {
  return (
    <div className="policy-page">
      <section className="lp-section">
        <div className="lp-container policy-container">
          {/* Header / Hero testo */}
          <header className="policy-header">
            <p className="policy-kicker">Legal</p>
            <h1 className="lp-section-title">Privacy &amp; Data Policy</h1>
            <p className="lp-text policy-intro">
              This platform connects your business channels (web, WhatsApp,
              Facebook, Instagram) to an AI assistant and Google Calendar.
              Below you can find how we handle and protect your data.
            </p>
          </header>

          {/* Contenuto policy */}
          <div className="policy-grid">
            <section className="policy-section">
              <h2 className="policy-subtitle">What we collect</h2>
              <ul className="policy-list">
                <li>Account information: email, login details.</li>
                <li>
                  Bot configuration: name, slug, domain, system prompts, enabled
                  features.
                </li>
                <li>
                  Conversation data: messages between users and your assistant
                  (across all channels).
                </li>
                <li>
                  Integration identifiers: WhatsApp phone number IDs, Facebook
                  Page IDs, Instagram business IDs, Google Calendar IDs.
                </li>
              </ul>
            </section>

            <section className="policy-section">
              <h2 className="policy-subtitle">How we use your data</h2>
              <ul className="policy-list">
                <li>
                  To provide AI-powered chat and booking for your business.
                </li>
                <li>
                  To send messages through third-party APIs like Meta (WhatsApp,
                  Facebook, Instagram).
                </li>
                <li>
                  To create and manage bookings in your Google Calendar via a
                  service account.
                </li>
              </ul>
            </section>

            <section className="policy-section">
              <h2 className="policy-subtitle">Third-party services</h2>
              <p className="lp-text">
                We rely on third-party providers such as OpenAI, Google, Meta,
                Stripe and hosting providers to deliver the service. Your data
                may be processed by these vendors according to their own terms
                and privacy policies.
              </p>
            </section>

            <section className="policy-section">
              <h2 className="policy-subtitle">Data retention &amp; deletion</h2>
              <p className="lp-text">
                Conversation data and configuration is retained for as long as
                your account is active. You can request deletion of your account
                and related data by contacting support. Bookings already created
                in your Google Calendar remain under your Google account and are
                not automatically removed.
              </p>
            </section>

            <section className="policy-section">
              <h2 className="policy-subtitle">Questions</h2>
              <p className="lp-text">
                For any privacy questions or data deletion requests, please
                contact us using the email address you used to register.
              </p>
            </section>
          </div>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
};

export default PolicyPage;
