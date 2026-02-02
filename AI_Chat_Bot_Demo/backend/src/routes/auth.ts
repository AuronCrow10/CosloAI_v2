import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  createRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
  sendVerificationEmail,
  googleClient,
  signMfaToken,
  verifyMfaToken
} from "../services/authService";
import { config } from "../config";
import { authenticator } from "otplib";
import { randomInt } from "crypto";
import { addSeconds } from "date-fns";
import { sendMail } from "../services/mailer";
import { REFERRAL_COOKIE_NAME, validateReferralCode } from "../services/referralService";

const router = Router();

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

const ipKey = (req: Request) => req.ip || req.socket.remoteAddress || null;
const emailKey = (req: Request) => {
  const email = (req.body?.email as string | undefined)?.toLowerCase().trim();
  return email ? `email:${email}` : null;
};

const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => (ipKey(req) ? `login:${ipKey(req)}` : null),
  message: "Too many login attempts. Please try again later."
});

const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFn: (req) => (emailKey(req) ? `login:${emailKey(req)}` : null)
});

const resetIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFn: (req) => (ipKey(req) ? `reset:${ipKey(req)}` : null),
  message: "Too many reset attempts. Please try again later."
});

const resetEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  keyFn: (req) => (emailKey(req) ? `reset:${emailKey(req)}` : null)
});

const mfaIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyFn: (req) => (ipKey(req) ? `mfa:${ipKey(req)}` : null)
});

const isProd = process.env.NODE_ENV === "production";
const cookieSameSite =
  (process.env.COOKIE_SAMESITE as "lax" | "strict" | "none" | undefined) ||
  (process.env.FRONTEND_ORIGIN && !process.env.FRONTEND_ORIGIN.includes("localhost")
    ? "none"
    : "lax");
const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: cookieSameSite,
    domain: cookieDomain,
    maxAge: config.jwtAccessExpiresIn * 1000
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: cookieSameSite,
    domain: cookieDomain,
    maxAge: config.jwtRefreshExpiresIn * 1000
  });
}

function clearAuthCookies(res: Response) {
  res.clearCookie("accessToken", {
    httpOnly: true,
    secure: isProd,
    sameSite: cookieSameSite,
    domain: cookieDomain
  });
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: isProd,
    sameSite: cookieSameSite,
    domain: cookieDomain
  });
}

export const passwordSchema = z
  .string()
  .min(8, "La password deve avere almeno 8 caratteri")
  .regex(/[A-Z]/, "La password deve contenere almeno una lettera maiuscola")
  .regex(/[a-z]/, "La password deve contenere almeno una lettera minuscola")
  .regex(/[0-9]/, "La password deve contenere almeno una cifra")
  .regex(
    /[^A-Za-z0-9]/,
    "La password deve contenere almeno un carattere speciale (es. !@#$%^&*)"
  );

const registerSchema = z.object({
  email: z.string().email("Inserisci un indirizzo email valido"),
  password: passwordSchema
});

async function markLegalAcceptanceIfMissing(userId: string) {
  const now = new Date();
  const currentTerms = config.termsVersion ?? "2025-12-18";
  const currentPrivacy = config.privacyVersion ?? "2025-12-18";

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  const needsTerms = !user.termsAcceptedAt || user.termsVersion !== currentTerms;
  const needsPrivacy = !user.privacyAcceptedAt || user.privacyVersion !== currentPrivacy;

  if (!needsTerms && !needsPrivacy) return;

  await prisma.user.update({
    where: { id: userId },
    data: {
      ...(needsTerms
        ? { termsAcceptedAt: now, termsVersion: currentTerms }
        : {}),
      ...(needsPrivacy
        ? { privacyAcceptedAt: now, privacyVersion: currentPrivacy }
        : {}),
    },
  });
}

router.post("/register", async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(400).json({ error: "Email already in use" });

  const passwordHash = await hashPassword(password);

  let referralCodeId: string | null = null;
  const rawReferral = (req as any).cookies?.[REFERRAL_COOKIE_NAME] as string | undefined;
  if (rawReferral) {
    const valid = await validateReferralCode(rawReferral);
    if (valid) referralCodeId = valid.referralCodeId;
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: "CLIENT",
      emailVerified: false,
      referralCodeId: referralCodeId ?? undefined,
      referredAt: referralCodeId ? new Date() : undefined
    }
  });

  await sendVerificationEmail(user.id, email);

  return res
    .status(201)
    .json({ message: "Registered; check your email to verify." });
});

const verifyEmailSchema = z.object({
  token: z.string()
});

router.post("/verify-email", async (req: Request, res: Response) => {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { token } = parsed.data;
  const record = await prisma.emailVerificationToken.findUnique({
    where: { token }
  });
  if (!record || record.expiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerified: true }
    }),
    prisma.emailVerificationToken.delete({ where: { id: record.id } })
  ]);

  return res.json({ message: "Email verified" });
});

const forgotPasswordSchema = z.object({
  email: z.string().email()
});

router.post("/forgot-password", resetIpLimiter, resetEmailLimiter, async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });

  // Always respond with a generic message to avoid account enumeration.
  const safeResponse = {
    message:
      "If an account exists for this email, you will receive a reset code shortly."
  };

  if (!user || !user.passwordHash) {
    return res.json(safeResponse);
  }

  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  const codeHash = await hashPassword(code);
  const expiresAt = addSeconds(new Date(), 60 * 10); // 10 minutes

  await prisma.passwordResetToken.deleteMany({
    where: { userId: user.id }
  });

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      codeHash,
      expiresAt
    }
  });

  await sendMail({
    to: email,
    subject: "Your Coslo password reset code",
    text:
      `Your password reset code is ${code}. ` +
      "It expires in 10 minutes. If you didn't request this, you can ignore this email.",
    html:
      `<p>Your password reset code is <strong>${code}</strong>.</p>` +
      "<p>This code expires in 10 minutes.</p>" +
      "<p>If you didn't request this, you can ignore this email.</p>"
  });

  return res.json(safeResponse);
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: passwordSchema
});

router.post("/reset-password", resetIpLimiter, resetEmailLimiter, async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email, code, newPassword } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash) {
    return res.status(400).json({ error: "Invalid or expired code." });
  }

  const token = await prisma.passwordResetToken.findFirst({
    where: {
      userId: user.id,
      usedAt: null,
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: "desc" }
  });

  if (!token) {
    return res.status(400).json({ error: "Invalid or expired code." });
  }

  const ok = await verifyPassword(code, token.codeHash);
  if (!ok) {
    return res.status(400).json({ error: "Invalid or expired code." });
  }

  const newHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash }
    }),
    prisma.passwordResetToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() }
    }),
    prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null }
    })
  ]);

  await revokeAllRefreshTokensForUser(user.id);

  return res.json({ message: "Password updated successfully." });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

router.post("/login", loginIpLimiter, loginEmailLimiter, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    return res.status(400).json({ error: "Invalid credentials" });
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: "Invalid credentials" });

  if (!user.emailVerified) {
    console.warn("User logging in without verified email", { userId: user.id });
  }

  // If MFA is enabled, return an MFA challenge instead of full session
  if (user.mfaEnabled && user.mfaTotpSecret) {
    const mfaToken = signMfaToken(user.id);
    return res.json({ mfaRequired: true, mfaToken });
  }

  const payload = { sub: user.id, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = await createRefreshToken(user.id);

  await markLegalAcceptanceIfMissing(user.id);

  setAuthCookies(res, accessToken, refreshToken);

  return res.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified
    }
  });
});

const refreshSchema = z.object({
  refreshToken: z.string().optional()
});

/**
 * Refresh session:
 * - Validate opaque refresh token in DB
 * - Load user
 * - Issue new access token
 * - Rotate refresh token (revoke old, create new)
 */
router.post("/refresh", async (req: Request, res: Response) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const refreshToken =
    parsed.data.refreshToken || ((req as any).cookies?.refreshToken as string | undefined);
  if (!refreshToken) {
    return res.status(401).json({ error: "Invalid refresh token" });
  }

  const dbToken = await prisma.refreshToken.findUnique({
    where: { token: refreshToken }
  });
  if (!dbToken || dbToken.expiresAt < new Date()) {
    return res.status(401).json({ error: "Invalid refresh token" });
  }

  const user = await prisma.user.findUnique({ where: { id: dbToken.userId } });
  if (!user) {
    return res.status(401).json({ error: "Invalid refresh token" });
  }

  const payload = { sub: user.id, role: user.role };
  const accessToken = signAccessToken(payload);

  // Rotate refresh token
  await revokeRefreshToken(refreshToken);
  const newRefreshToken = await createRefreshToken(user.id);

  setAuthCookies(res, accessToken, newRefreshToken);

  return res.json({
    accessToken,
    refreshToken: newRefreshToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified
    }
  });
});

const logoutSchema = z.object({
  refreshToken: z.string().nullable().optional()
});

router.post("/logout", async (req: Request, res: Response) => {
  const parsed = logoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const refreshToken =
    parsed.data.refreshToken ||
    ((req as any).cookies?.refreshToken as string | undefined);
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }

  clearAuthCookies(res);

  return res.json({ message: "Logged out" });
});

// ---- Google OAuth login ----

const googleSchema = z.object({
  idToken: z.string()
});

router.post("/google", async (req: Request, res: Response) => {
  const audiences = [
    config.googleClientId,
    (config as any).googleAndroidClientId
  ].filter(Boolean);

  if (!googleClient || audiences.length === 0) {
    return res.status(500).json({ error: "Google OAuth not configured" });
  }

  const parsed = googleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { idToken } = parsed.data;

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({
      idToken,
      audience: audiences
    });
  } catch (err) {
    console.error("Google token verification failed", err);
    return res.status(400).json({ error: "Invalid Google token" });
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    return res.status(400).json({ error: "Invalid Google payload" });
  }

  const googleId = payload.sub;
  const email = payload.email;

  let referralCodeId: string | null = null;
  const rawReferral = (req as any).cookies?.[REFERRAL_COOKIE_NAME] as string | undefined;
  if (rawReferral) {
    const valid = await validateReferralCode(rawReferral);
    if (valid) referralCodeId = valid.referralCodeId;
  }

  let user = await prisma.user.findUnique({ where: { googleId } });
  if (!user) {
    user = await prisma.user.upsert({
      where: { email },
      update: {
        googleId,
        emailVerified: true
      },
      create: {
        email,
        googleId,
        role: "CLIENT",
        emailVerified: true,
        referralCodeId: referralCodeId ?? undefined,
        referredAt: referralCodeId ? new Date() : undefined
      }
    });
  }

  // If MFA is enabled, return MFA challenge (same as email/password flow)
  if (user.mfaEnabled && user.mfaTotpSecret) {
    const mfaToken = signMfaToken(user.id);
    return res.json({ mfaRequired: true, mfaToken });
  }

  const tokenPayload = { sub: user.id, role: user.role };
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = await createRefreshToken(user.id);

  await markLegalAcceptanceIfMissing(user.id);

  setAuthCookies(res, accessToken, refreshToken);

  return res.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified
    }
  });
});

// ---- MFA TOTP verification for login ----

const mfaTotpVerifySchema = z.object({
  mfaToken: z.string(),
  code: z
    .string()
    .regex(/^\d{6}$/, "Invalid code format. It should be a 6-digit code.")
});

router.post("/mfa/totp/verify", mfaIpLimiter, async (req: Request, res: Response) => {
  const parsed = mfaTotpVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { mfaToken, code } = parsed.data;

  let payload;
  try {
    payload = verifyMfaToken(mfaToken);
  } catch {
    return res.status(400).json({ error: "Invalid or expired MFA token" });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub }
  });

  if (!user || !user.mfaEnabled || !user.mfaTotpSecret) {
    return res
      .status(400)
      .json({ error: "Two-factor authentication is not enabled for this user." });
  }

  const isValid = authenticator.verify({
    token: code,
    secret: user.mfaTotpSecret
  });

  if (!isValid) {
    return res.status(400).json({ error: "Invalid authentication code." });
  }

  const tokenPayload = { sub: user.id, role: user.role as "ADMIN" | "CLIENT" | "REFERRER" };
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = await createRefreshToken(user.id);

  await markLegalAcceptanceIfMissing(user.id);

  setAuthCookies(res, accessToken, refreshToken);

  return res.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified
    }
  });
});

export default router;
