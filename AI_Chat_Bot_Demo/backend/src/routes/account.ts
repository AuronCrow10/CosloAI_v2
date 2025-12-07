// routes/account.ts
import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { verifyAccessToken, verifyPassword, hashPassword, revokeAllRefreshTokensForUser } from "../services/authService";
import { JwtPayload } from "../services/authService";
import { passwordSchema } from "./auth"; // or re-export it there

const router = Router();

// Helper to get authenticated user from Bearer token
async function getAuthenticatedUser(req: Request, res: Response) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  let payload: JwtPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    res.status(401).json({ error: "Invalid access token" });
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return null;
  }

  return user;
}

// ── GET /account/me ─────────────────────────────────────────

router.get("/me", async (req: Request, res: Response) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return;

  const hasPassword = !!user.passwordHash;
  const authProvider = user.googleId
    ? "google"
    : hasPassword
    ? "password"
    : "unknown";

  return res.json({
    id: user.id,
    email: user.email,
    name: user.name ?? "",
    avatarUrl: user.avatarUrl ?? null,
    emailVerified: user.emailVerified,
    hasPassword,
    authProvider
  });
});

// ── PUT /account/profile ────────────────────────────────────

const profileSchema = z.object({
  name: z
    .string()
    .min(1, "Name must not be empty")
    .max(100, "Name too long")
    .optional(),
  avatarUrl: z
    .string()
    .url("Invalid avatar URL")
    .max(500)
    .optional()
});

router.put("/profile", async (req: Request, res: Response) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return;

  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const dataToUpdate: any = {};
  if ("name" in parsed.data) {
    dataToUpdate.name = parsed.data.name || null;
  }
  if ("avatarUrl" in parsed.data) {
    dataToUpdate.avatarUrl = parsed.data.avatarUrl || null;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: dataToUpdate
  });

  const hasPassword = !!updated.passwordHash;
  const authProvider = updated.googleId
    ? "google"
    : hasPassword
    ? "password"
    : "unknown";

  return res.json({
    id: updated.id,
    email: updated.email,
    name: updated.name ?? "",
    avatarUrl: updated.avatarUrl ?? null,
    emailVerified: updated.emailVerified,
    hasPassword,
    authProvider
  });
});

// ── POST /account/change-password ───────────────────────────

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: passwordSchema
});

router.post("/change-password", async (req: Request, res: Response) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return;

  if (!user.passwordHash) {
    return res
      .status(400)
      .json({ error: "Password login is not enabled for this account." });
  }

  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { currentPassword, newPassword } = parsed.data;

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }

  const newHash = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash }
  });

  // Optional but good practice: revoke all refresh tokens so sessions must re-login
  await revokeAllRefreshTokensForUser(user.id);

  return res.json({ message: "Password updated successfully." });
});

// TODO: 2FA endpoints later (TOTP / backup codes etc.)

export default router;
