import { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma/prisma";
import { verifyAccessToken, JwtPayload } from "../services/authService";
import {
  TeamPagePermission,
  userHasAnyTeamPagePermission
} from "../services/teamAccessService";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: "ADMIN" | "CLIENT" | "REFERRER" | "TEAM_MEMBER";
      };
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const cookieToken = (req as any).cookies?.accessToken as string | undefined;
  const token =
    header && header.startsWith("Bearer ")
      ? header.substring("Bearer ".length)
      : cookieToken;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  let payload: JwtPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  req.user = {
    id: user.id,
    email: user.email,
    role: user.role
  };

  if (req.user.role === "TEAM_MEMBER") {
    const path = (req.originalUrl || "").split("?")[0];
    const method = req.method.toUpperCase();
    const permission = await resolveTeamPermissionForRequest(req, path, method);
    if (!permission.allowed) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  return next();
}

type TeamPermissionCheck =
  | { allowed: true; unrestricted: true }
  | { allowed: true; botId: string; anyOf: TeamPagePermission[] }
  | { allowed: false };

function bodyValue(body: any, key: string): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as any)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function queryValue(req: Request, key: string): string | null {
  const value = (req.query as any)?.[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

async function resolveBotIdFromConversation(conversationId: string): Promise<string | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { botId: true }
  });
  return conversation?.botId ?? null;
}

async function resolveBotIdFromMetaSession(sessionId: string): Promise<string | null> {
  const session = await prisma.metaConnectSession.findUnique({
    where: { id: sessionId },
    select: { botId: true }
  });
  return session?.botId ?? null;
}

async function resolveBotIdFromWhatsappSession(sessionId: string): Promise<string | null> {
  const session = await prisma.whatsappConnectSession.findUnique({
    where: { id: sessionId },
    select: { botId: true }
  });
  return session?.botId ?? null;
}

async function resolveBotIdFromShopDomain(rawShopDomain: string): Promise<string | null> {
  const shop = await prisma.shopifyShop.findUnique({
    where: { shopDomain: rawShopDomain },
    select: { botId: true }
  });
  return shop?.botId ?? null;
}

function botPathMatch(path: string, suffix?: string): RegExpMatchArray | null {
  const escapedSuffix = suffix ? suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const regex = suffix
    ? new RegExp(`^/api/bots/([^/]+)${escapedSuffix}$`)
    : /^\/api\/bots\/([^/]+)$/;
  return path.match(regex);
}

async function buildTeamPermissionCheck(
  req: Request,
  path: string,
  method: string
): Promise<TeamPermissionCheck> {
  if (method === "GET" && path === "/api/bots") {
    return { allowed: true, unrestricted: true };
  }

  const selfRoute = path.startsWith("/api/account/");
  if (selfRoute) {
    return { allowed: true, unrestricted: true };
  }

  const exactBot = botPathMatch(path);
  if (exactBot) {
    const botId = exactBot[1];
    if (method === "GET") {
      return { allowed: true, botId, anyOf: ["BOT_DETAIL"] };
    }
    if (method === "PATCH") {
      return { allowed: true, botId, anyOf: ["BOT_SETTINGS"] };
    }
    return { allowed: false };
  }

  const pricingPreview = botPathMatch(path, "/pricing-preview");
  if (pricingPreview && method === "POST") {
    return { allowed: true, botId: pricingPreview[1], anyOf: ["BOT_DETAIL"] };
  }

  const revenueAi = path.match(/^\/api\/bots\/([^/]+)\/revenue-ai(\/override)?$/);
  if (revenueAi) {
    if (method === "GET" || method === "PUT") {
      return { allowed: true, botId: revenueAi[1], anyOf: ["BOT_REVENUE_AI"] };
    }
    return { allowed: false };
  }

  const knowledgePath = path.match(/^\/api\/bots\/([^/]+)\/knowledge(\/.*)?$/);
  if (knowledgePath) {
    const botId = knowledgePath[1];
    if (path.includes("/knowledge/chunks")) {
      return { allowed: true, botId, anyOf: ["BOT_KNOWLEDGE_JOB"] };
    }
    if (path.endsWith("/knowledge/crawl-status")) {
      return {
        allowed: true,
        botId,
        anyOf: ["BOT_KNOWLEDGE", "BOT_KNOWLEDGE_JOB"]
      };
    }
    return { allowed: true, botId, anyOf: ["BOT_KNOWLEDGE"] };
  }

  const channelsPath = path.match(/^\/api\/bots\/([^/]+)\/channels(\/.*)?$/);
  if (channelsPath) {
    const botId = channelsPath[1];
    if (method === "GET") {
      return {
        allowed: true,
        botId,
        anyOf: ["BOT_DETAIL", "BOT_CHANNELS", "BOT_WHATSAPP_TEMPLATES"]
      };
    }
    if (["POST", "PATCH", "DELETE"].includes(method)) {
      return { allowed: true, botId, anyOf: ["BOT_CHANNELS"] };
    }
    return { allowed: false };
  }

  const templatesPath = path.match(/^\/api\/bots\/([^/]+)\/whatsapp\/templates(\/.*)?$/);
  if (templatesPath) {
    return {
      allowed: true,
      botId: templatesPath[1],
      anyOf: ["BOT_WHATSAPP_TEMPLATES"]
    };
  }

  const metaLeadsAutomationPath = path.match(/^\/api\/bots\/([^/]+)\/meta-leads\/automation$/);
  if (metaLeadsAutomationPath) {
    const botId = metaLeadsAutomationPath[1];
    if (method === "GET") {
      return {
        allowed: true,
        botId,
        anyOf: ["BOT_DETAIL", "BOT_WHATSAPP_TEMPLATES"]
      };
    }
    if (method === "PUT") {
      return { allowed: true, botId, anyOf: ["BOT_WHATSAPP_TEMPLATES"] };
    }
    return { allowed: false };
  }

  const metaLeadsPath = path.match(/^\/api\/bots\/([^/]+)\/meta-leads$/);
  if (metaLeadsPath) {
    return { allowed: true, botId: metaLeadsPath[1], anyOf: ["BOT_WHATSAPP_TEMPLATES"] };
  }

  const conversationListPath = path.match(/^\/api\/conversations\/bots\/([^/]+)$/);
  if (conversationListPath && method === "GET") {
    return { allowed: true, botId: conversationListPath[1], anyOf: ["BOT_CONVERSATIONS"] };
  }

  const conversationPath = path.match(/^\/api\/conversations\/([^/]+)\/([^/]+)$/);
  if (conversationPath) {
    const conversationId = conversationPath[1];
    const action = conversationPath[2];
    const allowedAction =
      (method === "GET" && (action === "messages" || action === "details")) ||
      (method === "POST" && (action === "send" || action === "mode"));
    if (!allowedAction) return { allowed: false };

    const botId = await resolveBotIdFromConversation(conversationId);
    if (!botId) return { allowed: false };
    return { allowed: true, botId, anyOf: ["BOT_CONVERSATIONS"] };
  }

  const metaConnectPath = path.match(/^\/api\/bots\/meta\/([^/]+)\/connect$/);
  if (metaConnectPath && method === "GET") {
    return { allowed: true, botId: metaConnectPath[1], anyOf: ["BOT_CHANNELS"] };
  }

  const metaSessionPath = path.match(/^\/api\/meta\/sessions\/([^/]+)(\/attach)?$/);
  if (metaSessionPath && (method === "GET" || method === "POST")) {
    const botId = await resolveBotIdFromMetaSession(metaSessionPath[1]);
    if (!botId) return { allowed: false };
    return { allowed: true, botId, anyOf: ["BOT_CHANNELS"] };
  }

  const waEmbeddedPath = path.match(/^\/api\/bots\/([^/]+)\/whatsapp\/embedded\/complete$/);
  if (waEmbeddedPath && method === "POST") {
    return { allowed: true, botId: waEmbeddedPath[1], anyOf: ["BOT_CHANNELS"] };
  }

  const waSessionPath = path.match(/^\/api\/whatsapp\/sessions\/([^/]+)\/attach$/);
  if (waSessionPath && method === "POST") {
    const botId = await resolveBotIdFromWhatsappSession(waSessionPath[1]);
    if (!botId) return { allowed: false };
    return { allowed: true, botId, anyOf: ["BOT_CHANNELS"] };
  }

  if (path === "/api/shopify/install" && method === "GET") {
    const botId = queryValue(req, "botId");
    if (!botId) return { allowed: false };
    return { allowed: true, botId, anyOf: ["BOT_SHOPIFY"] };
  }

  if (path === "/api/shopify/shops" && method === "GET") {
    const botId = queryValue(req, "botId");
    if (!botId) return { allowed: false };
    return { allowed: true, botId, anyOf: ["BOT_SHOPIFY", "BOT_DETAIL"] };
  }

  const shopLinkPath = path.match(/^\/api\/shopify\/shops\/([^/]+)\/link$/);
  if (shopLinkPath && method === "PATCH") {
    const bodyBotId = bodyValue(req.body, "botId");
    if (bodyBotId) {
      return { allowed: true, botId: bodyBotId, anyOf: ["BOT_SHOPIFY"] };
    }
    const botId = await resolveBotIdFromShopDomain(shopLinkPath[1]);
    if (!botId) return { allowed: false };
    return { allowed: true, botId, anyOf: ["BOT_SHOPIFY"] };
  }

  const shopScopedPath = path.match(/^\/api\/shopify\/([^/]+)\/(sync\/products|products\/search|cart)$/);
  if (shopScopedPath) {
    const botId = await resolveBotIdFromShopDomain(shopScopedPath[1]);
    if (!botId) return { allowed: false };
    return { allowed: true, botId, anyOf: ["BOT_SHOPIFY"] };
  }

  if (
    (path === "/api/shopify/catalog-schema" && method === "GET") ||
    (path === "/api/shopify/catalog-schema/rebuild" && method === "POST") ||
    (path === "/api/shopify/catalog-context" && (method === "GET" || method === "PATCH")) ||
    (path === "/api/shopify/catalog-context/rebuild" && method === "POST")
  ) {
    const botId =
      queryValue(req, "botId") ||
      bodyValue(req.body, "botId") ||
      (await resolveBotIdFromShopDomain(
        queryValue(req, "shopDomain") || bodyValue(req.body, "shopDomain") || ""
      ));
    if (!botId) return { allowed: false };
    return { allowed: true, botId, anyOf: ["BOT_SHOPIFY"] };
  }

  if (path === "/api/dashboard/revenue-ai" && method === "GET") {
    const botId = queryValue(req, "botId");
    if (!botId) return { allowed: false };
    return { allowed: true, botId, anyOf: ["BOT_REVENUE_AI"] };
  }

  return { allowed: false };
}

async function resolveTeamPermissionForRequest(
  req: Request,
  path: string,
  method: string
): Promise<{ allowed: boolean }> {
  const check = await buildTeamPermissionCheck(req, path, method);
  if (!check.allowed) return { allowed: false };
  if ("unrestricted" in check) return { allowed: true };
  if (!req.user) return { allowed: false };

  const ok = await userHasAnyTeamPagePermission(req.user, check.botId, check.anyOf);
  return { allowed: ok };
}

export function requireRole(role: "ADMIN") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== role) return res.status(403).json({ error: "Forbidden" });
    return next();
  };
}
