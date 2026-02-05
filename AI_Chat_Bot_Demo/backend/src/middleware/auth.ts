import { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma/prisma";
import { verifyAccessToken, JwtPayload } from "../services/authService";

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

    const allowBotList = method === "GET" && path === "/api/bots";
    const allowConversationList =
      method === "GET" && path.startsWith("/api/conversations/bots/");
    const allowConversationRead =
      method === "GET" &&
      (path.endsWith("/messages") || path.endsWith("/details")) &&
      path.startsWith("/api/conversations/");
    const allowConversationWrite =
      method === "POST" &&
      (path.endsWith("/send") || path.endsWith("/mode")) &&
      path.startsWith("/api/conversations/");

    if (!(allowBotList || allowConversationList || allowConversationRead || allowConversationWrite)) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  return next();
}

export function requireRole(role: "ADMIN") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== role) return res.status(403).json({ error: "Forbidden" });
    return next();
  };
}
