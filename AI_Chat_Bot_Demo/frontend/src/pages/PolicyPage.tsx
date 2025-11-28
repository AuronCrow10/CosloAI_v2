// src/pages/PolicyPage.tsx
import React from "react";

const PolicyPage: React.FC = () => {
  return (
    <div className="page-container">
      <h1>Privacy & Data Policy</h1>
      <p>
        This platform connects your business channels (web, WhatsApp, Facebook,
        Instagram) to an AI assistant and Google Calendar.
      </p>
      <h2>What we collect</h2>
      <ul>
        <li>Account information: email, login details.</li>
        <li>
          Bot configuration: name, slug, domain, system prompts, enabled
          features.
        </li>
        <li>
          Conversation data: messages between users and your assistant (across
          all channels).
        </li>
        <li>
          Integration identifiers: WhatsApp phone number IDs, Facebook Page IDs,
          Instagram business IDs, Google Calendar IDs.
        </li>
      </ul>
      <h2>How we use your data</h2>
      <ul>
        <li>To provide AI-powered chat and booking for your business.</li>
        <li>
          To send messages through third-party APIs like Meta (WhatsApp,
          Facebook, Instagram).
        </li>
        <li>
          To create and manage bookings in your Google Calendar via a service
          account.
        </li>
      </ul>
      <h2>Third-party services</h2>
      <p>
        We rely on third-party providers such as OpenAI, Google, Meta, Stripe
        and hosting providers to deliver the service. Your data may be processed
        by these vendors according to their own terms and privacy policies.
      </p>
      <h2>Data retention & deletion</h2>
      <p>
        Conversation data and configuration is retained for as long as your
        account is active. You can request deletion of your account and related
        data by contacting support. Bookings already created in your Google
        Calendar remain under your Google account and are not automatically
        removed.
      </p>
      <h2>Questions</h2>
      <p>
        For any privacy questions or data deletion requests, please contact us
        using the email address you used to register.
      </p>
    </div>
  );
};

export default PolicyPage;
