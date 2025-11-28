// src/pages/app/BotFeaturesPage.tsx
import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Bot,
  getBotById,
  updateBot,
  startBotCheckout,
  getBotPricingPreview,
  BotPricingPreview,
  BotPricingPreviewPayload,
  FeatureCode,
  cancelBotSubscription
} from "../../api/bots";

const formatCurrency = (amountCents: number, currency: string) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2
  }).format(amountCents / 100);

const BotFeaturesPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [form, setForm] = useState<{
    useDomainCrawler: boolean;
    usePdfCrawler: boolean;
    channelWeb: boolean;
    channelWhatsapp: boolean;
    channelInstagram: boolean;
    channelMessenger: boolean;
    useCalendar: boolean;
    calendarId: string;
    timeZone: string;
    defaultDurationMinutes: string;
  } | null>(null);

  const [pricing, setPricing] = useState<BotPricingPreview | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);

  const [cancelLoading, setCancelLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getBotById(id)
      .then((data) => {
        setBot(data);
        const initialForm = {
          useDomainCrawler: data.useDomainCrawler,
          usePdfCrawler: data.usePdfCrawler,
          channelWeb: data.channelWeb,
          channelWhatsapp: data.channelWhatsapp,
          channelInstagram: data.channelInstagram,
          channelMessenger: data.channelMessenger,
          useCalendar: data.useCalendar,
          calendarId: data.calendarId || "",
          timeZone: data.timeZone || "",
          defaultDurationMinutes: data.defaultDurationMinutes
            ? String(data.defaultDurationMinutes)
            : "30"
        };
        setForm(initialForm);
        // Initial server-side pricing preview
        loadPricing(data.id, {
          useDomainCrawler: initialForm.useDomainCrawler,
          usePdfCrawler: initialForm.usePdfCrawler,
          channelWeb: initialForm.channelWeb,
          channelWhatsapp: initialForm.channelWhatsapp,
          channelMessenger: initialForm.channelMessenger,
          channelInstagram: initialForm.channelInstagram,
          useCalendar: initialForm.useCalendar
        });
      })
      .catch((err: any) => {
        console.error(err);
        setError(err.message || "Failed to load bot");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const loadPricing = (botId: string, payload?: BotPricingPreviewPayload) => {
    setPricingLoading(true);
    setPricingError(null);
    getBotPricingPreview(botId, payload)
      .then((data) => {
        setPricing(data);
      })
      .catch((err: any) => {
        console.error("Failed to load pricing preview", err);
        setPricingError("Unable to load pricing right now.");
      })
      .finally(() => setPricingLoading(false));
  };

  const handleToggle =
    (field: keyof NonNullable<typeof form>) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!form || !bot) return;
      const value =
        e.target.type === "checkbox"
          ? (e.target as HTMLInputElement).checked
          : e.target.value;

      const updatedForm = { ...form, [field]: value } as typeof form;
      setForm(updatedForm);

      // Only booleans matter for pricing; send them to the server
      const payload: BotPricingPreviewPayload = {
        useDomainCrawler: updatedForm.useDomainCrawler,
        usePdfCrawler: updatedForm.usePdfCrawler,
        channelWeb: updatedForm.channelWeb,
        channelWhatsapp: updatedForm.channelWhatsapp,
        channelMessenger: updatedForm.channelMessenger,
        channelInstagram: updatedForm.channelInstagram,
        useCalendar: updatedForm.useCalendar
      };
      loadPricing(bot.id, payload);
    };

  const handleCancelSubscription = async () => {
  if (!id) return;
  setCancelLoading(true);
  setError(null);
  setSuccess(null);
  try {
    const updated = await cancelBotSubscription(id);
    setBot(updated);
    setSuccess("Subscription canceled and bot deactivated.");
  } catch (err: any) {
    console.error(err);
    setError(err.message || "Failed to cancel subscription");
  } finally {
    setCancelLoading(false);
  }
};

  const handleChange =
    (field: keyof NonNullable<typeof form>) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!form) return;
      setForm({ ...form, [field]: e.target.value } as any);
    };

  const persistFeatures = async () => {
    if (!id || !form) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const duration = parseInt(form.defaultDurationMinutes, 10);
      const defaultDurationMinutes =
        Number.isFinite(duration) && duration > 0 ? duration : 30;

      const payload = {
        useDomainCrawler: form.useDomainCrawler,
        usePdfCrawler: form.usePdfCrawler,
        channelWeb: form.channelWeb,
        channelWhatsapp: form.channelWhatsapp,
        channelInstagram: form.channelInstagram,
        channelMessenger: form.channelMessenger,
        useCalendar: form.useCalendar,
        calendarId: form.useCalendar ? form.calendarId || null : null,
        timeZone: form.useCalendar ? form.timeZone || null : null,
        defaultDurationMinutes: form.useCalendar ? defaultDurationMinutes : null
      };

      const updated = await updateBot(id, payload);
      setBot(updated);
      setSuccess("Features & plan settings updated.");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to update bot features");
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleSave: React.FormEventHandler = async (e) => {
    e.preventDefault();
    try {
      await persistFeatures();
    } catch {
      // error already set
    }
  };

  const handleCheckout = async () => {
    if (!id || !bot) return;
    setCheckoutLoading(true);
    setError(null);
    try {
      // Ensure features are persisted before computing final server-side price
      await persistFeatures();
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
  const calendarIncomplete =
    form.useCalendar && (!form.calendarId.trim() || !form.timeZone.trim());
  const missingDomainForCrawler =
    form.useDomainCrawler && !(bot.domain && bot.domain.trim());

  const getLine = (code: FeatureCode) =>
    pricing?.lineItems.find((li) => li.code === code);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Features &amp; Plan</h1>
          <p className="muted">
            Configure channels, crawlers and booking for{" "}
            <strong>{bot.name}</strong>. These options influence your
            subscription price.
          </p>
        </div>
        <Link to={`/app/bots/${bot.id}`} className="btn-secondary">
          ← Back to bot
        </Link>
      </div>

      {error && <div className="form-error">{error}</div>}
      {success && <div className="form-success">{success}</div>}

      {missingDomainForCrawler && (
        <div className="alert-warning" style={{ marginBottom: "1rem" }}>
          Domain crawler is enabled but no domain is set. Go to{" "}
          <Link to={`/app/bots/${bot.id}/knowledge`}>
            Content &amp; Knowledge
          </Link>{" "}
          to configure a domain.
        </div>
      )}

      {calendarIncomplete && (
        <div className="alert-warning" style={{ marginBottom: "1rem" }}>
          Calendar booking is enabled but calendar ID or time zone is missing.
          Fill them below to allow bookings to work properly.
        </div>
      )}

      <div className="detail-layout">
        <section className="detail-main">
          <form className="form" onSubmit={handleSave}>
            <fieldset className="form-fieldset">
              <legend>Knowledge features</legend>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={form.useDomainCrawler}
                  onChange={handleToggle("useDomainCrawler")}
                />
                <span>
                  Domain crawler (website content)
                  {getLine("DOMAIN_CRAWLER") && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      +
                      {
                        getLine("DOMAIN_CRAWLER")!.monthlyAmountFormatted
                      }{" "}
                      / month
                    </span>
                  )}
                </span>
              </label>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={form.usePdfCrawler}
                  onChange={handleToggle("usePdfCrawler")}
                />
                <span>
                  PDF / document ingestion
                  {getLine("PDF_CRAWLER") && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      +
                      {getLine("PDF_CRAWLER")!.monthlyAmountFormatted} / month
                    </span>
                  )}
                </span>
              </label>
            </fieldset>

            <fieldset className="form-fieldset">
              <legend>Channels</legend>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={form.channelWeb}
                  onChange={handleToggle("channelWeb")}
                />
                <span>
                  Web (widget / demo page)
                  {getLine("CHANNEL_WEB") && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      +
                      {getLine("CHANNEL_WEB")!.monthlyAmountFormatted} / month
                    </span>
                  )}
                </span>
              </label>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={form.channelWhatsapp}
                  onChange={handleToggle("channelWhatsapp")}
                />
                <span>
                  WhatsApp
                  {getLine("WHATSAPP") && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      +
                      {getLine("WHATSAPP")!.monthlyAmountFormatted} / month
                    </span>
                  )}
                </span>
              </label>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={form.channelMessenger}
                  onChange={handleToggle("channelMessenger")}
                />
                <span>
                  Facebook Messenger
                  {getLine("MESSENGER") && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      +
                      {getLine("MESSENGER")!.monthlyAmountFormatted} / month
                    </span>
                  )}
                </span>
              </label>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={form.channelInstagram}
                  onChange={handleToggle("channelInstagram")}
                />
                <span>
                  Instagram DM
                  {getLine("INSTAGRAM") && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      +
                      {getLine("INSTAGRAM")!.monthlyAmountFormatted} / month
                    </span>
                  )}
                </span>
              </label>
            </fieldset>

            <fieldset className="form-fieldset">
              <legend>Bookings &amp; calendar</legend>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={form.useCalendar}
                  onChange={handleToggle("useCalendar")}
                />
                <span>
                  Use Google Calendar for bookings
                  {getLine("CALENDAR") && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      +
                      {getLine("CALENDAR")!.monthlyAmountFormatted} / month
                    </span>
                  )}
                </span>
              </label>

              {form.useCalendar && (
                <>
                  <label className="form-field">
                    <span>Google Calendar ID</span>
                    <input
                      type="text"
                      value={form.calendarId}
                      onChange={handleChange("calendarId")}
                      placeholder="your-calendar-id@group.calendar.google.com"
                    />
                  </label>
                  <label className="form-field">
                    <span>Business time zone</span>
                    <input
                      type="text"
                      value={form.timeZone}
                      onChange={handleChange("timeZone")}
                      placeholder="Europe/Rome"
                    />
                  </label>
                  <label className="form-field">
                    <span>Default appointment duration (minutes)</span>
                    <input
                      type="number"
                      min={5}
                      max={480}
                      value={form.defaultDurationMinutes}
                      onChange={handleChange("defaultDurationMinutes")}
                    />
                  </label>
                </>
              )}
            </fieldset>

            <button className="btn-primary" type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save features"}
            </button>
          </form>
        </section>

        <section className="detail-side">
          <h2>Plan &amp; billing</h2>
          <p>
            Status: <strong>{bot.status}</strong>
          </p>
          <p className="muted">
            The monthly price is computed on the server from the selected
            features. Stripe Checkout will charge this amount monthly, plus any
            applicable taxes.
          </p>

          {pricingLoading && <p>Loading pricing…</p>}
          {pricingError && <p className="form-error">{pricingError}</p>}

          {pricing && (
            <>
              <h3 style={{ marginTop: "1rem" }}>Current selection</h3>
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
              <div
                className="plan-summary-total"
                style={{ marginTop: "0.5rem" }}
              >
                <span>Total per month</span>
                <strong>{pricing.totalAmountFormatted}</strong>
              </div>
            </>
          )}

          {!isActive && (
            <button
              className="btn-primary"
              onClick={handleCheckout}
              disabled={checkoutLoading}
              style={{ marginTop: "1rem" }}
            >
              {checkoutLoading ? "Redirecting..." : "Activate &amp; Pay"}
            </button>
          )}

          {isActive && (
            <>
              <p className="form-success" style={{ marginTop: "0.5rem" }}>
                This bot is active and billed via Stripe.
              </p>
              <button
                className="btn-secondary"
                onClick={handleCancelSubscription}
                disabled={cancelLoading}
                style={{ marginTop: "0.5rem" }}
              >
                {cancelLoading ? "Cancelling..." : "Cancel subscription"}
              </button>
            </>
          )}

          <h3 style={{ marginTop: "2rem" }}>Quick links</h3>
          <ul className="link-list">
            <li>
              <Link to={`/app/bots/${bot.id}/knowledge`}>
                Content &amp; Knowledge
              </Link>
            </li>
            <li>
              <Link to={`/app/bots/${bot.id}/channels`}>Channel config</Link>
            </li>
            <li>
              <Link to={`/app/bots/${bot.id}/conversations`}>Conversations</Link>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
};

export default BotFeaturesPage;
