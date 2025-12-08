// routes/account.ts
import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { verifyAccessToken, verifyPassword, hashPassword, revokeAllRefreshTokensForUser, googleClient } from "../services/authService";
import { JwtPayload } from "../services/authService";
import { passwordSchema } from "./auth"; // or re-export it there
import { deleteKnowledgeClient } from "../services/knowledgeClient";
import { config } from "../config";

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


// ── DELETE /account ─────────────────────────────────────────
// Permanently delete the logged-in user and ALL related data.
// Password accounts: require current password.
// Google accounts: require a fresh Google ID token.
const deleteAccountSchema = z.object({
  password: z.string().optional(),
  googleIdToken: z.string().optional()
});

router.delete("/", async (req: Request, res: Response) => {
  const authUser = await getAuthenticatedUser(req, res);
  if (!authUser) return;

  const parsed = deleteAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { password, googleIdToken } = parsed.data;

  // Reload full user with auth fields
  const user = await prisma.user.findUnique({
    where: { id: authUser.id }
  });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // 1) Strong re-auth depending on account type
  if (user.passwordHash) {
    // Password-based account
    if (!password) {
      return res
        .status(400)
        .json({ error: "Password is required to delete this account." });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return res.status(400).json({ error: "Password is incorrect." });
    }
  } else if (user.googleId) {
    // Google-only account
    if (!googleIdToken) {
      return res.status(400).json({
        error: "Google re-authentication token is required."
      });
    }

    if (!googleClient || !config.googleClientId) {
      return res
        .status(500)
        .json({ error: "Google OAuth not configured on server." });
    }

    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken: googleIdToken,
        audience: config.googleClientId
      });
    } catch (err) {
      console.error(
        "Google ID token verification failed for account deletion",
        err
      );
      return res.status(400).json({ error: "Invalid Google token." });
    }

    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      return res.status(400).json({ error: "Invalid Google payload." });
    }

    if (payload.sub !== user.googleId) {
      return res.status(400).json({
        error: "Google token does not belong to this account."
      });
    }

    // Optional: warn if email differs
    if (payload.email && payload.email !== user.email) {
      console.warn("Google email mismatch on account deletion", {
        userId: user.id,
        userEmail: user.email,
        tokenEmail: payload.email
      });
    }
  } else {
    return res.status(400).json({
      error: "This account has no supported authentication method."
    });
  }

  // 2) Gather user's bots & knowledge clients before deleting
  const userWithBots = await prisma.user.findUnique({
    where: { id: user.id },
    include: { bots: true }
  });
  if (!userWithBots) {
    // Should not happen, but be safe:
    return res.status(404).json({ error: "User not found" });
  }

  const botIds = userWithBots.bots.map((b) => b.id);
  const knowledgeClientIds = userWithBots.bots
    .map((b) => b.knowledgeClientId)
    .filter((id): id is string => !!id);

  // 3) Delete everything in a transaction (DB side)
  await prisma.$transaction(async (tx) => {
    if (botIds.length > 0) {
      await tx.botChannel.deleteMany({ where: { botId: { in: botIds } } });
      await tx.metaConnectSession.deleteMany({
        where: { botId: { in: botIds } }
      });
      await tx.whatsappConnectSession.deleteMany({
        where: { botId: { in: botIds } }
      });
      await tx.conversation.deleteMany({ where: { botId: { in: botIds } } });
      await tx.payment.deleteMany({ where: { botId: { in: botIds } } });
      await tx.openAIUsage.deleteMany({ where: { botId: { in: botIds } } });
      await tx.subscription.deleteMany({ where: { botId: { in: botIds } } });
      await tx.bot.deleteMany({ where: { id: { in: botIds } } });
    }

    // User-level tokens/sessions/usages
    await tx.refreshToken.deleteMany({ where: { userId: user.id } });
    await tx.emailVerificationToken.deleteMany({ where: { userId: user.id } });
    await tx.metaConnectSession.deleteMany({ where: { userId: user.id } });
    await tx.whatsappConnectSession.deleteMany({
      where: { userId: user.id }
    });
    await tx.openAIUsage.deleteMany({ where: { userId: user.id } });

    await tx.user.delete({ where: { id: user.id } });
  });

  // 4) Best-effort knowledge deletion in scraper DB
  for (const clientId of knowledgeClientIds) {
    try {
      await deleteKnowledgeClient(clientId);
    } catch (err) {
      console.error(
        "Failed to delete knowledge client for user",
        { userId: user.id, clientId },
        err
      );
    }
  }

  return res.json({
    message: "Account and all related data have been permanently deleted."
  });
});

export default router;
