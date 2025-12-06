// src/pages/app/BillingPage.tsx
import React, { useEffect, useState } from "react";
import {
  BillingOverviewResponse,
  SubscriptionSummary,
  PaymentSummary,
  getPaymentInvoiceUrl,
  fetchBillingOverview
} from "../../api/billing";

function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2
  }).format(cents / 100);
}

// Map Stripe status -> badge class using your generic status-badge styles
function subscriptionStatusBadgeClass(status: string): string {
  const base = "status-badge ";
  switch (status) {
    case "ACTIVE":
    case "TRIALING":
      return base + "status-badge-ok";
    case "PAST_DUE":
    case "UNPAID":
    case "INCOMPLETE":
    case "INCOMPLETE_EXPIRED":
      return base + "status-badge-warn";
    case "CANCELED":
    default:
      return base + "status-badge-error";
  }
}

function subscriptionStatusLabel(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "Active";
    case "PAST_DUE":
      return "Past due";
    case "CANCELED":
      return "Canceled";
    case "TRIALING":
      return "Trial";
    case "UNPAID":
      return "Unpaid";
    case "INCOMPLETE":
      return "Incomplete";
    case "INCOMPLETE_EXPIRED":
      return "Incomplete (expired)";
    default:
      return status;
  }
}

// Usage badge (per bot) – also uses status-badge styles
function usageStatusBadgeClass(usagePercent: number | null): string | null {
  if (usagePercent == null) return null;
  const base = "status-badge ";
  if (usagePercent >= 100) return base + "status-badge-error";
  if (usagePercent >= 90) return base + "status-badge-warn";
  if (usagePercent >= 75) return base + "status-badge-warn";
  return base + "status-badge-ok";
}

function usageStatusLabel(usagePercent: number | null): string | null {
  if (usagePercent == null) return null;
  if (usagePercent >= 100) return "Over limit";
  if (usagePercent >= 90) return "At limit";
  if (usagePercent >= 75) return "High usage";
  return "Healthy usage";
}

const BillingPage: React.FC = () => {
  const [data, setData] = useState<BillingOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoiceLoadingId, setInvoiceLoadingId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchBillingOverview()
      .then((res) => setData(res))
      .catch((err: any) =>
        setError(err.message || "Failed to load billing overview")
      )
      .finally(() => setLoading(false));
  }, []);

  const handleDownloadInvoice = async (payment: PaymentSummary) => {
    if (!payment.hasInvoice) return;
    setInvoiceLoadingId(payment.id);
    setError(null);
    try {
      const { url } = await getPaymentInvoiceUrl(payment.id);
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        setError("Invoice is not available for this payment.");
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to download invoice.");
    } finally {
      setInvoiceLoadingId(null);
    }
  };

  // Global usage aggregation for header
  const totalUsedTokens =
    data?.subscriptions.reduce(
      (sum, s) => sum + s.usedTokensThisPeriod,
      0
    ) ?? 0;

  const totalLimitTokens =
    data?.subscriptions.reduce(
      (sum, s) => sum + (s.monthlyTokens || 0),
      0
    ) ?? 0;

  const hasAnyLimit = totalLimitTokens > 0;
  const globalUsagePercent = hasAnyLimit
    ? Math.min(100, Math.round((totalUsedTokens / totalLimitTokens) * 100))
    : null;

  const globalUsageBadgeClass = usageStatusBadgeClass(globalUsagePercent);
  const globalUsageBadgeLabel = usageStatusLabel(globalUsagePercent);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Billing &amp; usage</h1>
          <p className="muted">
            See your active bot subscriptions, usage this month and payment
            history.
          </p>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      {loading && (
        <div className="detail-main" style={{ marginTop: "1rem" }}>
          <p>Loading billing data...</p>
        </div>
      )}

      {!loading && data && (
        <>
          {/* Subscriptions + global usage summary */}
          <section className="detail-main billing-main-card">
            <div className="billing-summary-header">
              <div>
                <h2>Active subscriptions</h2>
                <p className="muted">
                  Total monthly across all bots:{" "}
                  <strong>{data.totalMonthlyAmountFormatted}</strong>
                </p>
              </div>

              {/* Global usage pill */}
              <div className="billing-summary-usage">
                <div className="billing-summary-usage-top">
                  {globalUsageBadgeClass && globalUsageBadgeLabel && (
                    <span className={globalUsageBadgeClass}>
                      {globalUsageBadgeLabel}
                    </span>
                  )}
                </div>
                <div className="billing-summary-usage-label">
                  This month:{" "}
                  <strong>
                    {totalUsedTokens.toLocaleString()} tokens
                  </strong>
                  {hasAnyLimit && (
                    <>
                      {" "}
                      <span className="muted">of</span>{" "}
                      <strong>{totalLimitTokens.toLocaleString()}</strong>
                    </>
                  )}
                </div>
                {hasAnyLimit && globalUsagePercent != null && (
                  <div className="billing-summary-usage-bar">
                    <div className="usage-bar">
                      <div
                        className="usage-bar-fill"
                        style={{ width: `${globalUsagePercent}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {data.subscriptions.length === 0 && (
              <p className="muted" style={{ marginTop: "0.5rem" }}>
                You don&apos;t have any active subscriptions yet.
              </p>
            )}

            {data.subscriptions.length > 0 && (
              <div className="billing-subscriptions">
                {data.subscriptions.map((sub) => {
                  const currency = sub.currency || "eur";
                  const usagePercent =
                    sub.usagePercent != null ? sub.usagePercent : null;
                  const hasLimit =
                    sub.monthlyTokens != null && sub.monthlyTokens > 0;
                  const usageBadgeClass = usageStatusBadgeClass(usagePercent);
                  const usageBadgeLabel = usageStatusLabel(usagePercent);

                  return (
                    <article
                      key={sub.botId}
                      className="billing-subscription-card"
                    >
                      <div className="billing-subscription-header">
                        <div className="billing-subscription-title-block">
                          <h3 className="billing-subscription-title">
                            {sub.botName}
                          </h3>
                          <p className="billing-subscription-subtitle">
                            Slug: <code>{sub.botSlug}</code>
                          </p>
                        </div>
                        <div className="billing-subscription-right">
                          <div
                            className={subscriptionStatusBadgeClass(
                              sub.subscriptionStatus
                            )}
                          >
                            {subscriptionStatusLabel(sub.subscriptionStatus)}
                          </div>
                          {usageBadgeClass && usageBadgeLabel && hasLimit && (
                            <div className="billing-subscription-usage-badge">
                              <span className={usageBadgeClass}>
                                {usageBadgeLabel}
                              </span>
                            </div>
                          )}
                          <div className="billing-subscription-price">
                            {sub.totalMonthlyAmountFormatted}
                            {sub.usagePlanName && (
                              <span className="billing-subscription-plan-label">
                                /month · {sub.usagePlanName}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="billing-subscription-breakdown">
                        <span>
                          Features:{" "}
                          <strong>
                            {formatAmount(
                              sub.featuresAmountCents,
                              currency
                            )}
                          </strong>
                        </span>
                        {sub.planAmountCents > 0 && (
                          <span>
                            Plan:{" "}
                            <strong>
                              {formatAmount(sub.planAmountCents, currency)}
                            </strong>
                          </span>
                        )}
                      </div>

                      <div className="billing-usage-section">
                        {hasLimit && usagePercent != null ? (
                          <>
                            <div className="usage-bar">
                              <div
                                className="usage-bar-fill"
                                style={{ width: `${usagePercent}%` }}
                              />
                            </div>
                            <p className="billing-usage-text">
                              Usage this month:{" "}
                              <strong>
                                {sub.usedTokensThisPeriod.toLocaleString()} /{" "}
                                {sub.monthlyTokens?.toLocaleString()} tokens
                              </strong>{" "}
                              ({usagePercent}%)
                            </p>
                          </>
                        ) : (
                          <p className="billing-usage-text">
                            Usage this month:{" "}
                            <strong>
                              {sub.usedTokensThisPeriod.toLocaleString()} tokens
                            </strong>{" "}
                            <span className="muted">(no configured limit)</span>
                          </p>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* Payment history */}
          <section className="detail-main" style={{ marginTop: "1.5rem" }}>
            <h2>Payment history</h2>
            {data.payments.length === 0 && (
              <p className="muted" style={{ marginTop: "0.5rem" }}>
                No payments recorded yet.
              </p>
            )}

            {data.payments.length > 0 && (
              <table className="table" style={{ marginTop: "0.75rem" }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Bot</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Period</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.payments.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {new Date(p.createdAt).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric"
                        })}
                      </td>
                      <td>{p.botName}</td>
                      <td>{formatAmount(p.amountCents, p.currency)}</td>
                      <td>{p.status}</td>
                      <td>
                        {p.periodStart && p.periodEnd ? (
                          <>
                            {new Date(p.periodStart).toLocaleDateString()} –{" "}
                            {new Date(p.periodEnd).toLocaleDateString()}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {p.hasInvoice ? (
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => handleDownloadInvoice(p)}
                            disabled={invoiceLoadingId === p.id}
                          >
                            {invoiceLoadingId === p.id
                              ? "Opening..."
                              : "Download invoice"}
                          </button>
                        ) : (
                          <span className="muted">No invoice</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default BillingPage;
