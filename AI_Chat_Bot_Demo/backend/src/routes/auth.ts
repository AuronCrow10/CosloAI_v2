import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  createRefreshToken,
  revokeRefreshToken,
  sendVerificationEmail,
  googleClient
} from "../services/authService";
import { config } from "../config";

const router = Router();

const passwordSchema = z
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

router.post("/register", async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(400).json({ error: "Email already in use" });

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: "CLIENT",
      emailVerified: false
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

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

router.post("/login", async (req: Request, res: Response) => {
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

  const payload = { sub: user.id, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = await createRefreshToken(user.id);

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
  refreshToken: z.string()
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

  const { refreshToken } = parsed.data;

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
  refreshToken: z.string().nullable()
});

router.post("/logout", async (req: Request, res: Response) => {
  const parsed = logoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { refreshToken } = parsed.data;
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }

  return res.json({ message: "Logged out" });
});

// ---- Google OAuth login ----

const googleSchema = z.object({
  idToken: z.string()
});

router.post("/google", async (req: Request, res: Response) => {
  if (!googleClient || !config.googleClientId) {
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
      audience: config.googleClientId
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
        emailVerified: true
      }
    });
  }

  const tokenPayload = { sub: user.id, role: user.role };
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = await createRefreshToken(user.id);

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
