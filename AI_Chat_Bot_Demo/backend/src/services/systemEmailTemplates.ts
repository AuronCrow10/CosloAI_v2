type EmailCta = {
  label: string;
  url: string;
};

type BrandedLayoutParams = {
  preheader: string;
  eyebrow: string;
  title: string;
  intro: string;
  bodyLines: string[];
  cta?: EmailCta;
  secondaryCta?: EmailCta;
  highlight?: {
    label: string;
    value: string;
    hint?: string;
  };
  footerLines?: string[];
};

export type SystemEmailMessage = {
  subject: string;
  text: string;
  html: string;
};

const DEFAULT_FRONTEND_ORIGIN = "http://localhost:3000";
const BRAND_NAME = "Coslo";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buttonHtml(cta: EmailCta, style: "primary" | "secondary"): string {
  const isPrimary = style === "primary";
  const background = isPrimary ? "#2563EB" : "#ffffff";
  const color = isPrimary ? "#ffffff" : "#1E293B";
  const border = isPrimary ? "1px solid #2563EB" : "1px solid #CBD5E1";

  return (
    `<a href="${escapeHtml(cta.url)}" ` +
    `style="display:inline-block;padding:12px 18px;border-radius:10px;` +
    `font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:700;` +
    `line-height:1;text-decoration:none;background:${background};color:${color};border:${border};">` +
    `${escapeHtml(cta.label)}</a>`
  );
}

function buildTextLayout(params: BrandedLayoutParams): string {
  const lines: string[] = [
    params.title,
    "",
    params.intro
  ];

  if (params.bodyLines.length > 0) {
    lines.push("");
    lines.push(...params.bodyLines);
  }

  if (params.highlight) {
    lines.push("");
    lines.push(`${params.highlight.label}: ${params.highlight.value}`);
    if (params.highlight.hint) {
      lines.push(params.highlight.hint);
    }
  }

  if (params.cta) {
    lines.push("");
    lines.push(`${params.cta.label}: ${params.cta.url}`);
  }
  if (params.secondaryCta) {
    lines.push(`${params.secondaryCta.label}: ${params.secondaryCta.url}`);
  }

  if (params.footerLines && params.footerLines.length > 0) {
    lines.push("");
    lines.push(...params.footerLines);
  }

  lines.push("");
  lines.push(`- ${BRAND_NAME}`);

  return lines.join("\n");
}

function buildHtmlLayout(params: BrandedLayoutParams): string {
  const paragraphs = params.bodyLines
    .map(
      (line) =>
        `<p style="margin:0 0 12px 0;font-family:'DM Sans',Arial,sans-serif;font-size:15px;line-height:1.6;color:#334155;">${escapeHtml(
          line
        )}</p>`
    )
    .join("");

  const highlightHtml = params.highlight
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:10px 0 20px 0;border-collapse:separate;border-spacing:0;">
        <tr>
          <td style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;padding:14px 16px;">
            <p style="margin:0 0 6px 0;font-family:'DM Sans',Arial,sans-serif;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#1D4ED8;font-weight:700;">${escapeHtml(
              params.highlight.label
            )}</p>
            <p style="margin:0;font-family:'DM Sans',Arial,sans-serif;font-size:28px;line-height:1.1;color:#0F172A;font-weight:800;">${escapeHtml(
              params.highlight.value
            )}</p>
            ${
              params.highlight.hint
                ? `<p style="margin:6px 0 0 0;font-family:'DM Sans',Arial,sans-serif;font-size:13px;line-height:1.5;color:#334155;">${escapeHtml(
                    params.highlight.hint
                  )}</p>`
                : ""
            }
          </td>
        </tr>
      </table>`
    : "";

  const ctaHtml = params.cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:6px 0 8px 0;">
        <tr><td>${buttonHtml(params.cta, "primary")}</td></tr>
      </table>`
    : "";

  const secondaryCtaHtml = params.secondaryCta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 10px 0;">
        <tr><td>${buttonHtml(params.secondaryCta, "secondary")}</td></tr>
      </table>`
    : "";

  const fallbackLinks = [params.cta, params.secondaryCta]
    .filter((item): item is EmailCta => !!item)
    .map(
      (item) =>
        `<p style="margin:8px 0 0 0;font-family:'DM Sans',Arial,sans-serif;font-size:12px;line-height:1.5;color:#64748B;">${escapeHtml(
          item.label
        )}: <a href="${escapeHtml(item.url)}" style="color:#2563EB;text-decoration:underline;">${escapeHtml(
          item.url
        )}</a></p>`
    )
    .join("");

  const footerHtml = (params.footerLines || [])
    .map(
      (line) =>
        `<p style="margin:0 0 8px 0;font-family:'DM Sans',Arial,sans-serif;font-size:13px;line-height:1.55;color:#64748B;">${escapeHtml(
          line
        )}</p>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(params.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#E9EEF7;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;line-height:1px;font-size:1px;color:transparent;">
      ${escapeHtml(params.preheader)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9EEF7;padding:20px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #D9E2F2;">
            <tr>
              <td style="padding:26px 30px;background:linear-gradient(135deg,#2563EB,#0F766E);">
                <p style="margin:0 0 12px 0;font-family:'DM Sans',Arial,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#DBEAFE;font-weight:700;">${escapeHtml(
                  params.eyebrow
                )}</p>
                <h1 style="margin:0;font-family:'DM Sans',Arial,sans-serif;font-size:28px;line-height:1.2;color:#ffffff;font-weight:800;">${escapeHtml(
                  params.title
                )}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:30px;">
                <p style="margin:0 0 16px 0;font-family:'DM Sans',Arial,sans-serif;font-size:16px;line-height:1.6;color:#1E293B;">${escapeHtml(
                  params.intro
                )}</p>
                ${paragraphs}
                ${highlightHtml}
                ${ctaHtml}
                ${secondaryCtaHtml}
                ${fallbackLinks}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 30px;background:#F8FAFC;border-top:1px solid #E2E8F0;">
                ${footerHtml}
                <p style="margin:4px 0 0 0;font-family:'DM Sans',Arial,sans-serif;font-size:12px;color:#94A3B8;">
                  ${new Date().getUTCFullYear()} ${BRAND_NAME}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildBrandedMessage(params: {
  subject: string;
  layout: BrandedLayoutParams;
}): SystemEmailMessage {
  return {
    subject: params.subject,
    text: buildTextLayout(params.layout),
    html: buildHtmlLayout(params.layout)
  };
}

export function getFrontendOrigin(): string {
  const raw = String(process.env.FRONTEND_ORIGIN || "").trim();
  if (!raw) return DEFAULT_FRONTEND_ORIGIN;
  return raw.replace(/\/+$/, "");
}

export function buildVerificationEmail(params: {
  verifyUrl: string;
}): SystemEmailMessage {
  return buildBrandedMessage({
    subject: "Verify your Coslo email",
    layout: {
      preheader: "Confirm your email address to activate your Coslo account.",
      eyebrow: "Coslo account security",
      title: "Verify your email",
      intro: "Your account is almost ready. Confirm your email to complete setup and start using Coslo.",
      bodyLines: [
        "For your security, this verification link expires in 24 hours."
      ],
      cta: {
        label: "Verify email",
        url: params.verifyUrl
      },
      footerLines: [
        "If you did not create this account, you can safely ignore this message."
      ]
    }
  });
}

export function buildPasswordResetEmail(params: {
  code: string;
  resetUrl: string;
}): SystemEmailMessage {
  return buildBrandedMessage({
    subject: "Your Coslo password reset code",
    layout: {
      preheader: "Use this code to reset your Coslo password.",
      eyebrow: "Coslo account security",
      title: "Reset your password",
      intro:
        "We received a request to reset your password. Use the code below in the reset page.",
      bodyLines: [
        "This code expires in 30 minutes."
      ],
      highlight: {
        label: "Reset code",
        value: params.code,
        hint: "Enter this code exactly as shown."
      },
      cta: {
        label: "Open reset page",
        url: params.resetUrl
      },
      footerLines: [
        "If you did not request a password reset, you can ignore this email."
      ]
    }
  });
}

export function buildTeamInviteEmail(params: {
  inviteUrl: string;
  botNames: string[];
}): SystemEmailMessage {
  const readableBotNames =
    params.botNames.length > 0 ? params.botNames.join(", ") : "your assigned bots";

  return buildBrandedMessage({
    subject: "You have been invited to join a Coslo workspace",
    layout: {
      preheader: "Accept your invite and join the workspace.",
      eyebrow: "Team access invitation",
      title: "You are invited",
      intro: "You have been invited to join a Coslo workspace.",
      bodyLines: [
        `Bots included in this invite: ${readableBotNames}.`,
        "This invitation can only be used once."
      ],
      cta: {
        label: "Accept invite",
        url: params.inviteUrl
      },
      footerLines: [
        "If this invitation was unexpected, you can ignore this message."
      ]
    }
  });
}

function buildUsageAlertCopy(params: {
  threshold: 50 | 70 | 90 | 100;
  botName: string;
  roundedPercent: number;
}): {
  subject: string;
  intro: string;
  bodyLine: string;
} {
  const { threshold, botName, roundedPercent } = params;

  if (threshold === 50) {
    return {
      subject: `Heads up: ${botName} has used 50% of its monthly quota`,
      intro: `Quick heads up: ${botName} has used about ${roundedPercent}% of this month's included tokens.`,
      bodyLine:
        "Usage looks healthy, but this is a good moment to confirm your plan matches expected traffic."
    };
  }
  if (threshold === 70) {
    return {
      subject: `${botName} is at 70% of its monthly plan`,
      intro: `${botName} has now consumed around ${roundedPercent}% of its monthly token budget.`,
      bodyLine:
        "If you expect campaign spikes, keep an eye on usage or consider upgrading."
    };
  }
  if (threshold === 90) {
    return {
      subject: `${botName} is close to its monthly limit (${roundedPercent}%)`,
      intro: `${botName} is approaching its monthly limit and is currently at about ${roundedPercent}%.`,
      bodyLine:
        "At this pace, usage may hit the cap soon and some operations could be limited until the next billing month."
    };
  }
  return {
    subject: `${botName} has reached 100% of its monthly usage`,
    intro: `${botName} has reached 100% of its monthly included token usage.`,
    bodyLine:
      "Further usage may be blocked or limited until the next billing month, depending on your plan setup."
  };
}

export function buildPlanUsageAlertEmail(params: {
  threshold: 50 | 70 | 90 | 100;
  percent: number;
  botName: string;
  usedTokens: number;
  limitTokens: number;
  dashboardUrl: string;
}): SystemEmailMessage {
  const roundedPercent = Math.min(100, Math.round(params.percent));
  const copy = buildUsageAlertCopy({
    threshold: params.threshold,
    botName: params.botName,
    roundedPercent
  });

  return buildBrandedMessage({
    subject: copy.subject,
    layout: {
      preheader: `${params.botName} usage update: ${roundedPercent}% of monthly quota used.`,
      eyebrow: "Plan usage alert",
      title: `${params.botName} usage update`,
      intro: copy.intro,
      bodyLines: [copy.bodyLine],
      highlight: {
        label: "Current usage",
        value: `${params.usedTokens.toLocaleString("en-US")} / ${params.limitTokens.toLocaleString(
          "en-US"
        )}`,
        hint: `${roundedPercent}% of monthly quota`
      },
      cta: {
        label: "Open dashboard",
        url: params.dashboardUrl
      },
      footerLines: [
        "Review your usage details and plan settings directly from your dashboard."
      ]
    }
  });
}
