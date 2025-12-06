// src/pages/app/BotFeaturesPage.tsx
import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Bot,
  getBotById,
  updateBot,
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
  const navigate = useNavigate();

  const [bot, setBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nextLoading, setNextLoading] = useState(false);
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
        // Initial server-side pricing preview (features only)
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
      setSuccess("Features updated.");
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

  // Go to plan selection (Step 2)
  const handleNextToPlan = async () => {
    if (!id || !bot) return;
    setNextLoading(true);
    setError(null);
    try {
      await persistFeatures();
      navigate(`/app/bots/${bot.id}/plan`);
    } catch (err) {
      // error already set by persistFeatures
    } finally {
      setNextLoading(false);
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

  const getLine = (code: FeatureCode) =>
    pricing?.lineItems.find((li) => li.code === code);


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
      <div className="page-header">
        <div>
          <h1>Features</h1>
          <p className="muted">
            Step 1 – configure channels, crawlers and booking for{" "}
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

      {calendarIncomplete && (
        <div className="alert-warning" style={{ marginBottom: "1rem" }}>
          Calendar booking is enabled but calendar ID or time zone is missing.
          Fill them below to allow bookings to work properly.
        </div>
      )}

      <div className="detail-layout">
        <section className="detail-main">
          <form className="form features-form" onSubmit={handleSave}>
<fieldset className="form-fieldset feature-group">
  <legend>Knowledge features</legend>
  <div className="feature-options">
    <label
      className={
        "feature-option" +
        (form.useDomainCrawler ? " feature-option-checked" : "")
      }
    >
      <input
        type="checkbox"
        checked={form.useDomainCrawler}
        onChange={handleToggle("useDomainCrawler")}
      />
      <div className="feature-option-content">
        <div className="feature-option-header">
          <div>
            <div className="feature-option-title">
              Domain crawler (website content)
            </div>
            <p className="feature-option-description">
              Automatically scan your website so the bot always answers with
              fresh, up-to-date content.
            </p>
          </div>
          {getLine("DOMAIN_CRAWLER") && (
            <span className="feature-option-price-badge">
              +<strong>{getLine("DOMAIN_CRAWLER")!.monthlyAmountFormatted}</strong>
              <span>/month</span>
            </span>
          )}
        </div>
      </div>
    </label>

    <label
      className={
        "feature-option" +
        (form.usePdfCrawler ? " feature-option-checked" : "")
      }
    >
      <input
        type="checkbox"
        checked={form.usePdfCrawler}
        onChange={handleToggle("usePdfCrawler")}
      />
      <div className="feature-option-content">
        <div className="feature-option-header">
          <div>
            <div className="feature-option-title">
              PDF / document ingestion
            </div>
            <p className="feature-option-description">
              Upload manuals, brochures or documents and let the bot answer
              questions based on them.
            </p>
          </div>
          {getLine("PDF_CRAWLER") && (
            <span className="feature-option-price-badge">
              +<strong>{getLine("PDF_CRAWLER")!.monthlyAmountFormatted}</strong>
              <span>/month</span>
            </span>
          )}
        </div>
      </div>
    </label>
  </div>
</fieldset>

            <fieldset className="form-fieldset feature-group">
  <legend>Channels</legend>
  <div className="feature-options">
    <label
      className={
        "feature-option" +
        (form.channelWeb ? " feature-option-checked" : "")
      }
    >
      <input
        type="checkbox"
        checked={form.channelWeb}
        onChange={handleToggle("channelWeb")}
      />
      <div className="feature-option-content">
        <div className="feature-option-header">
          <div>
            <div className="feature-option-title">
              Web widget &amp; hosted demo
            </div>
            <p className="feature-option-description">
              Embed a chat widget on your site and get a hosted demo link to
              share with your customers.
            </p>
          </div>
          {getLine("CHANNEL_WEB") && (
            <span className="feature-option-price-badge">
              +<strong>{getLine("CHANNEL_WEB")!.monthlyAmountFormatted}</strong>
              <span>/month</span>
            </span>
          )}
        </div>
      </div>
    </label>

    <label
      className={
        "feature-option" +
        (form.channelWhatsapp ? " feature-option-checked" : "")
      }
    >
      <input
        type="checkbox"
        checked={form.channelWhatsapp}
        onChange={handleToggle("channelWhatsapp")}
      />
      <div className="feature-option-content">
        <div className="feature-option-header">
          <div>
            <div className="feature-option-title">WhatsApp</div>
            <p className="feature-option-description">
              Connect your bot to WhatsApp so customers can chat with you from
              anywhere.
            </p>
          </div>
          {getLine("WHATSAPP") && (
            <span className="feature-option-price-badge">
              +<strong>{getLine("WHATSAPP")!.monthlyAmountFormatted}</strong>
              <span>/month</span>
            </span>
          )}
        </div>
      </div>
    </label>

    <label
      className={
        "feature-option" +
        (form.channelMessenger ? " feature-option-checked" : "")
      }
    >
      <input
        type="checkbox"
        checked={form.channelMessenger}
        onChange={handleToggle("channelMessenger")}
      />
      <div className="feature-option-content">
        <div className="feature-option-header">
          <div>
            <div className="feature-option-title">Facebook Messenger</div>
            <p className="feature-option-description">
              Answer questions directly on your Facebook page via Messenger.
            </p>
          </div>
          {getLine("MESSENGER") && (
            <span className="feature-option-price-badge">
              +<strong>{getLine("MESSENGER")!.monthlyAmountFormatted}</strong>
              <span>/month</span>
            </span>
          )}
        </div>
      </div>
    </label>

    <label
      className={
        "feature-option" +
        (form.channelInstagram ? " feature-option-checked" : "")
      }
    >
      <input
        type="checkbox"
        checked={form.channelInstagram}
        onChange={handleToggle("channelInstagram")}
      />
      <div className="feature-option-content">
        <div className="feature-option-header">
          <div>
            <div className="feature-option-title">Instagram DM</div>
            <p className="feature-option-description">
              Reply to Instagram direct messages automatically with your bot.
            </p>
          </div>
          {getLine("INSTAGRAM") && (
            <span className="feature-option-price-badge">
              +<strong>{getLine("INSTAGRAM")!.monthlyAmountFormatted}</strong>
              <span>/month</span>
            </span>
          )}
        </div>
      </div>
    </label>
  </div>
</fieldset>


<fieldset className="form-fieldset feature-group">
  <legend>Bookings &amp; calendar</legend>
  <div className="feature-options">
    <label
      className={
        "feature-option" +
        (form.useCalendar ? " feature-option-checked" : "")
      }
    >
      <input
        type="checkbox"
        checked={form.useCalendar}
        onChange={handleToggle("useCalendar")}
      />
      <div className="feature-option-content">
        <div className="feature-option-header">
          <div>
            <div className="feature-option-title">
              Google Calendar bookings
            </div>
            <p className="feature-option-description">
              Let the bot schedule meetings directly in your Google Calendar,
              with availability checks and time zones handled for you.
            </p>
          </div>
          {getLine("CALENDAR") && (
            <span className="feature-option-price-badge">
              +<strong>{getLine("CALENDAR")!.monthlyAmountFormatted}</strong>
              <span>/month</span>
            </span>
          )}
        </div>

        {form.useCalendar && (
          <div className="feature-option-extra">
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
          </div>
        )}
      </div>
    </label>
  </div>
</fieldset>


            <button className="btn-primary" type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save features"}
            </button>
          </form>
        </section>

<section className="detail-side">
  <div className="plan-summary-header">
    <h2 style={{ margin: 0 }}>Plan &amp; billing</h2>
    <span className={statusPillClass}>
      Status: <strong>{bot.status}</strong>
    </span>
  </div>
  <p className="muted" style={{ marginTop: "0.35rem" }}>
    Step 2 – choose a usage plan and confirm payment. The total price is:
    features subtotal + usage plan.
  </p>

  {pricingLoading && <p style={{ marginTop: "0.6rem" }}>Loading pricing…</p>}
  {pricingError && (
    <p className="form-error" style={{ marginTop: "0.6rem" }}>
      {pricingError}
    </p>
  )}

  {pricing && (
    <>
      <h3 style={{ marginTop: "0.9rem", marginBottom: "0.35rem" }}>
        Features subtotal
      </h3>

      <div className="plan-summary-lines">
        {pricing.lineItems.map((li) => (
          <div className="plan-summary-line" key={li.code}>
            <span className="plan-summary-line-label">{li.label}</span>
            <span className="plan-summary-line-amount">
              {li.monthlyAmountFormatted}
              /month
            </span>
          </div>
        ))}
      </div>

      <div className="plan-summary-total">
        <span>Features total (per month)</span>
        <strong>{pricing.totalAmountFormatted}</strong>
      </div>
    </>
  )}

  {!isActive && (
    <>
      <button
        className="btn-primary"
        onClick={handleNextToPlan}
        disabled={nextLoading || saving}
        style={{ marginTop: "1rem" }}
      >
        {nextLoading ? "Saving..." : "Next: choose plan &amp; pay"}
      </button>
      <p className="detail-side-note">
        You&apos;ll be redirected to a Stripe checkout page to confirm your
        subscription.
      </p>
    </>
  )}

{isActive && (
  <>

    {/* NEW: view / change plan button */}
    <button
      className="btn-primary"
      onClick={() => navigate(`/app/bots/${bot.id}/plan`)}
      style={{ marginTop: "0.75rem" }}
    >
      View / change plan
    </button>

    <button
      className="btn-secondary"
      onClick={handleCancelSubscription}
      disabled={cancelLoading}
      style={{ marginTop: "0.6rem" }}
    >
      {cancelLoading ? "Cancelling..." : "Cancel subscription"}
    </button>
  </>
)}
</section>
      </div>
    </div>
  );
};

export default BotFeaturesPage;
