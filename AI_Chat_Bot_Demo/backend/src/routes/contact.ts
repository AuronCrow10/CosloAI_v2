import { Request, Response, Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { sendMail } from "../services/mailer";

const router = Router();

const CONTACT_DESTINATION_EMAIL = "assistenza@coslo.it";

type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string | null;
  message?: string;
};

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: () => void) => {
    const key = options.keyFn(req);
    if (!key) return next();

    const now = Date.now();
    const entry = rateBuckets.get(key);

    if (!entry || entry.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (entry.count >= options.max) {
      return res.status(429).json({
        error: options.message || "Too many requests. Please try again later."
      });
    }

    entry.count += 1;
    return next();
  };
}

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFn: (req) => {
    const ip = req.ip || req.socket.remoteAddress || null;
    return ip ? `contact:${ip}` : null;
  },
  message: "Too many contact requests. Please try again later."
});

const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  phone: z
    .string()
    .trim()
    .max(40)
    .optional(),
  subject: z.string().trim().min(3).max(140),
  message: z.string().trim().min(10).max(4000),
  language: z.string().trim().max(16).optional()
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

router.post("/contact", contactLimiter, async (req: Request, res: Response) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  if (!config.smtpHost || !config.smtpPort || !config.smtpFrom) {
    return res.status(503).json({
      error: "Contact service is temporarily unavailable."
    });
  }

  const name = parsed.data.name.trim();
  const email = parsed.data.email.trim().toLowerCase();
  const phone = parsed.data.phone?.trim() || "";
  const subject = parsed.data.subject.replace(/[\r\n]+/g, " ").trim();
  const message = parsed.data.message.trim();
  const language = parsed.data.language?.trim() || "unknown";

  const mailSubject = `[Coslo Contact] ${subject}`;
  const textBody = [
    "New contact request from coslo.it",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone || "-"}`,
    `Language: ${language}`,
    "",
    "Message:",
    message
  ].join("\n");

  const htmlBody = `
    <p><strong>New contact request from coslo.it</strong></p>
    <p><strong>Name:</strong> ${escapeHtml(name)}<br />
    <strong>Email:</strong> ${escapeHtml(email)}<br />
    <strong>Phone:</strong> ${escapeHtml(phone || "-")}<br />
    <strong>Language:</strong> ${escapeHtml(language)}</p>
    <p><strong>Message:</strong><br />${escapeHtml(message).replace(/\n/g, "<br />")}</p>
  `;

  try {
    await sendMail({
      to: CONTACT_DESTINATION_EMAIL,
      subject: mailSubject,
      text: textBody,
      html: htmlBody,
      replyTo: email
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("[Contact] Failed to send contact email", err);
    return res.status(500).json({
      error: "Failed to send your message. Please try again later."
    });
  }
});

export default router;
