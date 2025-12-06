// src/pages/app/BotPlanPage.tsx
import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Bot,
  getBotById,
  getBotPricingPreview,
  BotPricingPreview,
  FeatureCode,
  fetchUsagePlans,
  UsagePlan,
  startBotCheckout
} from "../../api/bots";

import starterImg from "../../assets/coslo-assist-247.png";
import growthImg from "../../assets/coslo-assist-247.png";
import scaleImg from "../../assets/coslo-assist-247.png";
import defaultPlanImg from "../../assets/coslo-assist-247.png";

const formatCurrency = (amountCents: number, currency: string) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2
  }).format(amountCents / 100);

  const planImages: Record<string, string> = {
  starter: starterImg,
  basic: starterImg,
  growth: growthImg,
  pro: growthImg,
  scale: scaleImg,
  enterprise: scaleImg
};

const getPlanImage = (plan: UsagePlan): string => {
  const key = plan.name.toLowerCase();
  return planImages[key] ?? defaultPlanImg;
};


const BotPlanPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [bot, setBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [featuresPricing, setFeaturesPricing] = useState<BotPricingPreview | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);

  const [plans, setPlans] = useState<UsagePlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState<string | null>(null);

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);

    setPricingLoading(true);
    setPlansLoading(true);

    Promise.all([
      getBotById(id),
      getBotPricingPreview(id, {}),
      fetchUsagePlans()
    ])
      .then(([botData, pricing, plansData]) => {
        setBot(botData);
        setFeaturesPricing(pricing);
        setPlans(plansData);
        if (plansData.length > 0) {
          setSelectedPlanId(plansData[0].id);
        }
      })
      .catch((err: any) => {
        console.error(err);
        setError(err.message || "Failed to load plan data");
      })
      .finally(() => {
        setLoading(false);
        setPricingLoading(false);
        setPlansLoading(false);
      });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleSelectPlan = (planId: string) => {
    setSelectedPlanId(planId);
  };

  const handleActivateAndPay = async () => {
    if (!id || !bot) return;
    if (!selectedPlanId) {
      setError("Please select a plan.");
      return;
    }
    setCheckoutLoading(true);
    setError(null);
    try {
      const { checkoutUrl } = await startBotCheckout(id, {
        usagePlanId: selectedPlanId
      });
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
        <p>Loading plan options...</p>
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

  if (!bot) {
    return (
      <div className="page-container">
        <h1>Bot not found</h1>
      </div>
    );
  }

  const isActive = bot.status === "ACTIVE";

  const selectedPlan = plans.find((p) => p.id === selectedPlanId) || null;

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

  const combinedTotalFormatted =
    featuresPricing && selectedPlan
      ? formatCurrency(
          featuresPricing.totalAmountCents + selectedPlan.monthlyAmountCents,
          featuresPricing.currency
        )
      : null;

  const getFeatureLine = (code: FeatureCode) =>
    featuresPricing?.lineItems.find((li) => li.code === code);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Plan &amp; billing</h1>
          <p className="muted">
            Step 2 – choose a usage plan for <strong>{bot.name}</strong>.
            Final price = features subtotal + plan.
          </p>
        </div>
        <div className="header-actions">
          <button
            className="btn-secondary"
            type="button"
            onClick={() => navigate(`/app/bots/${bot.id}/features`)}
          >
            ← Back to features
          </button>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="detail-layout">
        <section className="detail-main">
<h2>Usage plans</h2>
<p className="usage-plans-subtitle">
  Pick how much usage you expect. You can change your plan later.
</p>

{plansLoading && <p>Loading plans…</p>}
{plansError && <p className="form-error">{plansError}</p>}

{plans.length === 0 && !plansLoading && (
  <p className="muted">
    No usage plans are configured yet. Please contact support.
  </p>
)}

<div className="plan-cards">
  {plans.map((plan) => {
    const isSelected = plan.id === selectedPlanId;
    return (
      <div
        key={plan.id}
        className={`plan-card ${isSelected ? "selected" : ""}`}
        onClick={() => handleSelectPlan(plan.id)}
      >
        <div className="plan-card-media">
          <img src={getPlanImage(plan)} alt={`${plan.name} plan`} />
        </div>

        <div className="plan-card-header">
          <div className="plan-card-name">{plan.name}</div>
          <div className="plan-card-price">
            {formatCurrency(plan.monthlyAmountCents, plan.currency)}
            /month
          </div>
        </div>

        {plan.description && (
          <p className="plan-card-description">{plan.description}</p>
        )}

        <ul className="plan-limits">
          <li>
            Tokens per month:{" "}
            <strong>{plan.monthlyTokens ?? "Unlimited"}</strong>
          </li>
        </ul>

        <button
          type="button"
          className="btn-secondary"
          onClick={(e) => {
            e.stopPropagation();
            handleSelectPlan(plan.id);
          }}
        >
          {isSelected ? "Selected" : "Select this plan"}
        </button>
      </div>
    );
  })}
</div>
        </section>

        <section className="detail-side">
  <div className="plan-summary-header">
    <h2 style={{ margin: 0 }}>Summary</h2>
    <span className={statusPillClass}>
      Status: <strong>{bot.status}</strong>
    </span>
  </div>
  <p className="muted" style={{ marginTop: "0.35rem" }}>
    Final price = features subtotal + selected usage plan.
  </p>

  <h3 style={{ marginTop: "0.9rem", marginBottom: "0.35rem" }}>
    Features subtotal
  </h3>
  {pricingLoading && <p>Loading pricing…</p>}
  {pricingError && <p className="form-error">{pricingError}</p>}

  {featuresPricing && (
    <>
      <div className="plan-summary-lines">
        {featuresPricing.lineItems.map((li) => (
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
        <strong>{featuresPricing.totalAmountFormatted}</strong>
      </div>
    </>
  )}

  <h3 style={{ marginTop: "1.4rem", marginBottom: "0.3rem" }}>
    Selected plan
  </h3>
  {selectedPlan ? (
    <div className="plan-summary-lines">
      <div className="plan-summary-line">
        <span className="plan-summary-line-label">{selectedPlan.name}</span>
        <span className="plan-summary-line-amount">
          {formatCurrency(
            selectedPlan.monthlyAmountCents,
            selectedPlan.currency
          )}
          /month
        </span>
      </div>
      <div className="plan-summary-line">
        <span className="plan-summary-line-label">Tokens per month</span>
        <span className="plan-summary-line-amount">
          {selectedPlan.monthlyTokens ?? "Unlimited"}
        </span>
      </div>
    </div>
  ) : (
    <p className="muted">No plan selected.</p>
  )}

  <div className="plan-summary-total" style={{ marginTop: "1.4rem" }}>
    <span>Total per month</span>
    <strong>
      {combinedTotalFormatted ?? "Select a plan to see total"}
    </strong>
  </div>

  {!isActive && (
    <>
      <button
        className="btn-primary"
        type="button"
        onClick={handleActivateAndPay}
        disabled={checkoutLoading || !selectedPlan}
        style={{ marginTop: "1rem" }}
      >
        {checkoutLoading ? "Redirecting..." : "Activate &amp; Pay"}
      </button>
      <p className="detail-side-note">
        You&apos;ll be redirected to Stripe to confirm and pay for this bot.
      </p>
    </>
  )}
</section>
      </div>
    </div>
  );
};

export default BotPlanPage;
