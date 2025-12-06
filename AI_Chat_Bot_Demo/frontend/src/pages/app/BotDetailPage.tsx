// src/pages/app/BotDetailPage.tsx
import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Bot,
  BotChannel,
  getBotById,
  updateBot,
  fetchChannels,
  getBotPricingPreview,
  BotPricingPreview
} from "../../api/bots";

const BotDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [channels, setChannels] = useState<BotChannel[] | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [form, setForm] = useState<{
    description: string;
    systemPrompt: string;
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
          systemPrompt: botData.systemPrompt
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
        systemPrompt: form.systemPrompt
      });
      setBot(updated);
      setSuccess("Bot basics updated successfully.");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to update bot");
    } finally {
      setSaving(false);
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

  const badgeClass = (kind: "ok" | "warn" | "error") => {
    if (kind === "ok") return "status-badge status-badge-ok";
    if (kind === "warn") return "status-badge status-badge-warn";
    return "status-badge status-badge-error";
  };

  const getBotStatusBadgeKind = (status: Bot["status"]): "ok" | "warn" | "error" => {
    const normalized = status.toUpperCase();
    if (normalized === "ACTIVE") return "ok";
    if (normalized === "DRAFT") return "warn";
    return "error"; // CANCELLED / INACTIVE / anything else
  };

  const getStatusPillClass = (status: Bot["status"]) => {
    const normalized = status.toUpperCase();
    if (normalized === "ACTIVE") {
      return "plan-summary-status plan-summary-status-ok";
    }
    if (normalized === "DRAFT") {
      return "plan-summary-status plan-summary-status-warn";
    }
    if (normalized === "CANCELLED" || normalized === "INACTIVE") {
      return "plan-summary-status plan-summary-status-error";
    }
    return "plan-summary-status";
  };

  const statusPillClass = getStatusPillClass(bot.status);

  return (
    <div>
      {/* HEADER / HERO */}
      <div className="page-header">
        <div className="bot-header">
          <div className="bot-avatar">
            {bot.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="bot-title">{bot.name}</h1>
            <p className="muted">
              Slug: <code>{bot.slug}</code>
            </p>
          </div>
        </div>
        <div className="page-header-actions">
          <span className={statusPillClass}>{bot.status}</span>
          <Link
            to={`/demo/${bot.slug}`}
            className="btn-secondary"
            target="_blank"
          >
            Open demo
          </Link>
          {!isActive && (
            <Link to={`/app/bots/${bot.id}/plan`} className="btn-primary">
              Activate &amp; Pay
            </Link>
          )}
          {isActive && (
            <Link to={`/app/bots/${bot.id}/plan`} className="btn-primary">
              View plan &amp; billing
            </Link>
          )}
        </div>
      </div>

      <div className="detail-layout">
        {/* LEFT: Bot basics + health overview */}
        <section className="detail-main">
          <h2>Bot basics</h2>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            High-level description and core behavior for this assistant.
          </p>
          <form className="form" onSubmit={handleSave}>
            {error && <div className="form-error">{error}</div>}
            {success && <div className="form-success">{success}</div>}

            <label className="form-field">
              <span>Description</span>
              <textarea
                value={form.description}
                onChange={handleChange("description")}
                rows={2}
                placeholder="Short description of what this bot does..."
              />
            </label>

            <label className="form-field">
              <span>System prompt (advanced behavior)</span>
              <textarea
                value={form.systemPrompt}
                onChange={handleChange("systemPrompt")}
                rows={5}
                placeholder="Internal instructions the AI must always follow..."
              />
              <span style={{ fontSize: "0.8rem", marginTop: "0.1rem" }}>
                This is not shown to end users. Use it to define tone, boundaries
                and special rules for the bot.
              </span>
            </label>

            <button className="btn-primary" type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save basics"}
            </button>
          </form>

          {/* HEALTH OVERVIEW */}
          <h2 style={{ marginTop: "2rem" }}>Health overview</h2>
          <div className="status-overview">
            {/* Bot status */}
            <div className="status-row">
              <div className="status-row-header">
                <span className="status-label">Bot status</span>
                <span className={badgeClass(getBotStatusBadgeKind(bot.status))}>
                  {bot.status}
                </span>
              </div>
              <p className="muted">
                {bot.status === "ACTIVE"
                  ? "This bot is active and ready to handle conversations."
                  : bot.status === "DRAFT"
                  ? "This bot is not active yet. You can activate it from the billing flow."
                  : "This bot is currently not active. Check your plan & billing or contact support if this is unexpected."}
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

        {/* RIGHT: navigation as main card */}
        <section className="detail-side">
          <h2>Bot workspace</h2>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            Jump to configuration and monitoring areas for this bot.
          </p>

          <ul className="bot-nav-list">
            <li>
              <Link
                to={`/app/bots/${bot.id}/features`}
                className="bot-nav-item"
              >
                <div className="bot-nav-item-main">
                  <span className="bot-nav-item-title">
                    Features &amp; Plan
                  </span>
                  <span className="bot-nav-item-description">
                    Enable channels, crawlers and choose the usage plan.
                  </span>
                </div>
                <span className="bot-nav-item-arrow">→</span>
              </Link>
            </li>
            <li>
              <Link
                to={`/app/bots/${bot.id}/knowledge`}
                className="bot-nav-item"
              >
                <div className="bot-nav-item-main">
                  <span className="bot-nav-item-title">
                    Content &amp; Knowledge
                  </span>
                  <span className="bot-nav-item-description">
                    Upload documents and configure how the bot learns.
                  </span>
                </div>
                <span className="bot-nav-item-arrow">→</span>
              </Link>
            </li>
            <li>
              <Link
                to={`/app/bots/${bot.id}/channels`}
                className="bot-nav-item"
              >
                <div className="bot-nav-item-main">
                  <span className="bot-nav-item-title">Channels</span>
                  <span className="bot-nav-item-description">
                    Connect WhatsApp, website, Facebook and Instagram.
                  </span>
                </div>
                <span className="bot-nav-item-arrow">→</span>
              </Link>
            </li>
            <li>
              <Link
                to={`/app/bots/${bot.id}/conversations`}
                className="bot-nav-item"
              >
                <div className="bot-nav-item-main">
                  <span className="bot-nav-item-title">Conversations</span>
                  <span className="bot-nav-item-description">
                    Review user chats and debug bot behavior.
                  </span>
                </div>
                <span className="bot-nav-item-arrow">→</span>
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
};

export default BotDetailPage;
