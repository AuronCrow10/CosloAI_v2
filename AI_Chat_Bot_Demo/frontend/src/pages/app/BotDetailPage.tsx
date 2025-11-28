// src/pages/app/BotDetailPage.tsx
import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Bot,
  BotChannel,
  getBotById,
  updateBot,
  startBotCheckout,
  fetchChannels,
  getBotPricingPreview,
  BotPricingPreview
} from "../../api/bots";

const formatCurrency = (amountCents: number, currency: string) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2
  }).format(amountCents / 100);

const BotDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [channels, setChannels] = useState<BotChannel[] | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [form, setForm] = useState<{
    description: string;
    systemPrompt: string;
    domain: string;
  } | null>(null);

  const [pricing, setPricing] = useState<BotPricingPreview | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);

    Promise.all([getBotById(id), fetchChannels(id)])
      .then(([botData, channelData]) => {
        setBot(botData);
        setChannels(channelData || []);
        setForm({
          description: botData.description || "",
          systemPrompt: botData.systemPrompt,
          domain: botData.domain || ""
        });

        // Load current plan breakdown from server (based on stored features)
        return getBotPricingPreview(botData.id);
      })
      .then((pricingData) => {
        setPricing(pricingData);
      })
      .catch((err: any) => {
        console.error(err);
        if (!bot) {
          setError(err.message || "Failed to load bot");
        }
        setPricingError("Unable to load current plan pricing.");
      })
      .finally(() => setLoading(false));
  }, [id]);

  const handleChange =
    (field: keyof NonNullable<typeof form>) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!form) return;
      const value = e.target.value;
      setForm({
        ...form,
        [field]: value
      });
    };

  const handleSave: React.FormEventHandler = async (e) => {
    e.preventDefault();
    if (!id || !form) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await updateBot(id, {
        description: form.description,
        systemPrompt: form.systemPrompt,
        domain: form.domain || null
      });
      setBot(updated);
      setSuccess("Bot basics updated successfully.");
      // Optionally refresh pricing if domain changes affect feature usage later
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to update bot");
    } finally {
      setSaving(false);
    }
  };

  const handleCheckout = async () => {
    if (!id) return;
    setCheckoutLoading(true);
    setError(null);
    try {
      const { checkoutUrl } = await startBotCheckout(id);
      window.location.href = checkoutUrl;
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to start checkout");
    } finally {
      setCheckoutLoading(false);
    }
  };

  if (!id) {
    return (
      <div className="page-container">
        <p>Missing bot ID.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page-container">
        <p>Loading bot...</p>
      </div>
    );
  }

  if (error && !bot) {
    return (
      <div className="page-container">
        <h1>Error</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!bot || !form) {
    return (
      <div className="page-container">
        <h1>Bot not found</h1>
      </div>
    );
  }

  const isActive = bot.status === "ACTIVE";

  // ---- STATUS LOGIC ----

  // Knowledge
  const knowledgeEnabled = bot.useDomainCrawler || bot.usePdfCrawler;
  const knowledgeInitialized = knowledgeEnabled && !!bot.knowledgeClientId;

  // Channels
  const channelsArray = channels || [];
  const selectedChannels = {
    web: bot.channelWeb,
    whatsapp: bot.channelWhatsapp,
    messenger: bot.channelMessenger,
    instagram: bot.channelInstagram
  };

  const webConfigured = !bot.channelWeb || !!bot.domain;
  const whatsappConfigured =
    !bot.channelWhatsapp ||
    channelsArray.some(
      (c) => c.type === "WHATSAPP" && !!c.externalId?.trim()
    );
  const messengerConfigured =
    !bot.channelMessenger ||
    channelsArray.some(
      (c) => c.type === "FACEBOOK" && !!c.externalId?.trim()
    );
  const instagramConfigured =
    !bot.channelInstagram ||
    channelsArray.some(
      (c) => c.type === "INSTAGRAM" && !!c.externalId?.trim()
    );

  const channelsEnabledCount = Object.values(selectedChannels).filter(Boolean)
    .length;

  const allSelectedChannelsConfigured =
    webConfigured &&
    whatsappConfigured &&
    messengerConfigured &&
    instagramConfigured;

  const missingChannelConfigs: string[] = [];
  if (bot.channelWeb && !webConfigured) missingChannelConfigs.push("Web domain");
  if (bot.channelWhatsapp && !whatsappConfigured)
    missingChannelConfigs.push("WhatsApp external ID");
  if (bot.channelMessenger && !messengerConfigured)
    missingChannelConfigs.push("Facebook Page ID");
  if (bot.channelInstagram && !instagramConfigured)
    missingChannelConfigs.push("Instagram Business ID");

  // Calendar
  const calendarEnabled = bot.useCalendar;
  const calendarConfigured =
    calendarEnabled &&
    !!bot.calendarId &&
    !!bot.timeZone &&
    !!bot.defaultDurationMinutes;

  // Nice helpers for badges
  const badgeClass = (kind: "ok" | "warn" | "error") => {
    // using existing-ish classes so it still looks decent
    if (kind === "ok") return "status-badge status-badge-ok";
    if (kind === "warn") return "status-badge status-badge-warn";
    return "status-badge status-badge-error";
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{bot.name}</h1>
          <p className="muted">
            Slug: <code>{bot.slug}</code> · Status:{" "}
            <strong>{bot.status}</strong>
          </p>
        </div>
        <div className="page-header-actions">
          <Link
            to={`/demo/${bot.slug}`}
            className="btn-secondary"
            target="_blank"
          >
            Open demo
          </Link>
          {!isActive && (
            <button
              className="btn-primary"
              onClick={handleCheckout}
              disabled={checkoutLoading}
            >
              {checkoutLoading ? "Redirecting..." : "Activate & Pay"}
            </button>
          )}
        </div>
      </div>

      <div className="detail-layout">
        {/* LEFT: Bot basics + overview */}
        <section className="detail-main">
          <h2>Bot basics</h2>
          <form className="form" onSubmit={handleSave}>
            {error && <div className="form-error">{error}</div>}
            {success && <div className="form-success">{success}</div>}

            <label className="form-field">
              <span>Description</span>
              <textarea
                value={form.description}
                onChange={handleChange("description")}
                rows={2}
              />
            </label>

            <label className="form-field">
              <span>System prompt</span>
              <textarea
                value={form.systemPrompt}
                onChange={handleChange("systemPrompt")}
                rows={4}
              />
            </label>
            {/*
            <label className="form-field">
              <span>Domain</span>
              <input
                type="text"
                value={form.domain}
                onChange={handleChange("domain")}
                placeholder="https://example.com"
              />
            </label>
            */}
            <button className="btn-primary" type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save basics"}
            </button>
          </form>

          {/* OVERVIEW just under Bot basics */}
          <h2 style={{ marginTop: "2rem" }}>Overview</h2>
          <div className="status-overview">
            {/* Bot status */}
            <div className="status-row">
              <div className="status-row-header">
                <span className="status-label">Bot status</span>
                <span
                  className={
                    bot.status === "ACTIVE"
                      ? badgeClass("ok")
                      : badgeClass("warn")
                  }
                >
                  {bot.status}
                </span>
              </div>
              <p className="muted">
                {bot.status === "ACTIVE"
                  ? "This bot is active and ready to handle conversations."
                  : "This bot is not active yet. You can activate it from the billing flow."}
              </p>
            </div>

            {/* Knowledge status */}
            <div className="status-row">
              <div className="status-row-header">
                <span className="status-label">Knowledge status</span>
                {knowledgeEnabled ? (
                  knowledgeInitialized ? (
                    <span className={badgeClass("ok")}>Configured</span>
                  ) : (
                    <span className={badgeClass("warn")}>
                      Enabled, not initialized
                    </span>
                  )
                ) : (
                  <span className={badgeClass("error")}>Disabled</span>
                )}
              </div>
              <p className="muted">
                {(!knowledgeEnabled &&
                  "Domain crawler / PDF ingestion are disabled for this bot.") ||
                  (knowledgeEnabled &&
                    !knowledgeInitialized &&
                    "Knowledge features are enabled, but no crawl/upload has initialized the knowledge base yet.") ||
                  (knowledgeEnabled &&
                    knowledgeInitialized &&
                    "Knowledge base is created and can be used for answers.")}
              </p>
            </div>

            {/* Channels status */}
            <div className="status-row">
              <div className="status-row-header">
                <span className="status-label">Channels status</span>
                {channelsEnabledCount === 0 ? (
                  <span className={badgeClass("warn")}>
                    No channels enabled
                  </span>
                ) : allSelectedChannelsConfigured ? (
                  <span className={badgeClass("ok")}>
                    All enabled channels configured
                  </span>
                ) : (
                  <span className={badgeClass("warn")}>
                    Some channels need setup
                  </span>
                )}
              </div>
              <p className="muted">
                {channelsEnabledCount === 0 && (
                  <>
                    No channels are enabled yet. Enable them in{" "}
                    <Link to={`/app/bots/${bot.id}/features`}>
                      Features &amp; Plan
                    </Link>{" "}
                    and configure them in{" "}
                    <Link to={`/app/bots/${bot.id}/channels`}>Channels</Link>.
                  </>
                )}
                {channelsEnabledCount > 0 && allSelectedChannelsConfigured && (
                  <>
                    Enabled channels:{" "}
                    {[
                      bot.channelWeb && "Web",
                      bot.channelWhatsapp && "WhatsApp",
                      bot.channelMessenger && "Facebook Messenger",
                      bot.channelInstagram && "Instagram DM"
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    . All of them have the required configuration.
                  </>
                )}
                {channelsEnabledCount > 0 &&
                  !allSelectedChannelsConfigured && (
                    <>
                      Some enabled channels are missing required configuration:{" "}
                      {missingChannelConfigs.join(", ")}. Go to{" "}
                      <Link to={`/app/bots/${bot.id}/channels`}>Channels</Link>{" "}
                      to complete the setup.
                    </>
                  )}
              </p>
            </div>

            {/* Calendar status */}
            <div className="status-row">
              <div className="status-row-header">
                <span className="status-label">Calendar status</span>
                {!calendarEnabled ? (
                  <span className={badgeClass("warn")}>Disabled</span>
                ) : calendarConfigured ? (
                  <span className={badgeClass("ok")}>Configured</span>
                ) : (
                  <span className={badgeClass("warn")}>
                    Enabled, not configured
                  </span>
                )}
              </div>
              <p className="muted">
                {!calendarEnabled &&
                  "Google Calendar bookings are disabled. You can enable them in Features & Plan."}
                {calendarEnabled &&
                  !calendarConfigured &&
                  "Calendar bookings are enabled, but calendar ID, time zone or duration are missing. Configure them in Features & Plan."}
                {calendarEnabled &&
                  calendarConfigured &&
                  `Bookings use Google Calendar (${bot.calendarId}) in ${bot.timeZone}, with default duration of ${
                    bot.defaultDurationMinutes || 30
                  } minutes.`}
              </p>
            </div>
          </div>
        </section>

        {/* RIGHT: navigation + subscription breakdown */}
        <section className="detail-side">
          <h2>Navigation</h2>
          <ul className="link-list">
            <li>
              <Link to={`/app/bots/${bot.id}/features`}>
                Features &amp; Plan
              </Link>
            </li>
            <li>
              <Link to={`/app/bots/${bot.id}/knowledge`}>
                Content &amp; Knowledge
              </Link>
            </li>
            <li>
              <Link to={`/app/bots/${bot.id}/channels`}>Channels</Link>
            </li>
            <li>
              <Link to={`/app/bots/${bot.id}/conversations`}>
                Conversations
              </Link>
            </li>
          </ul>

          <h3 style={{ marginTop: "2rem" }}>Subscription</h3>
          <p>
            Current status: <strong>{bot.status}</strong>
          </p>
          {!isActive && (
            <p className="muted">
              Activate this bot to start billing and use it in production.
            </p>
          )}
          {isActive && (
            <p className="form-success" style={{ marginTop: "0.25rem" }}>
              Active via Stripe subscription.
            </p>
          )}

          <h4 style={{ marginTop: "1rem" }}>Current plan</h4>
          {pricingError && (
            <p className="form-error">{pricingError}</p>
          )}
          {pricing ? (
            <>
              <ul className="link-list">
                {pricing.lineItems.map((li) => (
                  <li key={li.code}>
                    <span>{li.label}</span>
                    <span>
                      {li.monthlyAmountFormatted}
                      /month
                    </span>
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: "0.5rem" }}>
                <span>Total base price: </span>
                <strong>{pricing.totalAmountFormatted}</strong>
                <span className="muted"> per month (VAT/tax added by Stripe)</span>
              </div>
            </>
          ) : (
            <p className="muted">Loading current pricing…</p>
          )}
        </section>
      </div>
    </div>
  );
};

export default BotDetailPage;
