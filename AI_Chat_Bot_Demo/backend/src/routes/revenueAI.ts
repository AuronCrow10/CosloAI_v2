import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../prisma/prisma";
import { getPendingOfferEvent, trackRevenueAIAction } from "../services/revenueAIService";
import { createSlidingWindowLimiter } from "../services/revenueAIRateLimit";

const router = Router();

const actionSchema = z.object({
  eventId: z.string().min(1),
  botId: z.string().min(1),
  conversationId: z.string().min(1),
  action: z.enum(["CLICK", "ADD_TO_CART", "CHECKOUT"]),
  clientEventId: z.string().optional(),
  clientTs: z.number().optional(),
  sessionId: z.string().optional(),
  meta: z.any().optional(),
  suggestedProductId: z.string().optional(),
  offerType: z.enum(["UPSELL", "CROSS_SELL", "NEXT_BEST"]).optional(),
  stage: z.enum(["EXPLORATION", "EVALUATION", "CART", "CHECKOUT"]).optional(),
  style: z.enum(["SOFT", "CLOSER"]).optional()
});

const actionLimiter = createSlidingWindowLimiter({
  windowMs: 60 * 1000,
  max: 30
});

router.post("/revenue-ai/actions", async (req: Request, res: Response) => {
  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn("[RevenueAI] action invalid payload", {
      error: parsed.error.flatten(),
      body: req.body
    });
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  console.log("[RevenueAI] action received", {
    eventId: parsed.data.eventId,
    botId: parsed.data.botId,
    conversationId: parsed.data.conversationId,
    action: parsed.data.action,
    clientEventId: parsed.data.clientEventId ?? null,
    clientTs: parsed.data.clientTs ?? null,
    sessionId: parsed.data.sessionId ?? null,
    suggestedProductId: parsed.data.suggestedProductId ?? null,
    offerType: parsed.data.offerType ?? null,
    stage: parsed.data.stage ?? null,
    style: parsed.data.style ?? null
  });

  const ip = (req.headers["x-forwarded-for"] as string) || req.ip || "unknown";
  const rateKey = `${ip}`;
  if (!actionLimiter.allow(rateKey)) {
    console.warn("[RevenueAI] action rate limited", { ip });
    return res.status(429).json({ error: "Too many requests" });
  }

  // No deduping: count all clicks/actions, even repeated ones.

  let event = await prisma.revenueAIOfferEvent.findUnique({
    where: { id: parsed.data.eventId }
  });

  const clientTs = Number.isFinite(parsed.data.clientTs) ? Number(parsed.data.clientTs) : Date.now();

  if (!event) {
    const pending = getPendingOfferEvent(parsed.data.eventId);
    if (pending && pending.botId === parsed.data.botId && pending.conversationId === parsed.data.conversationId) {
      try {
        console.log("[RevenueAI] action using pending offer event", {
          eventId: pending.eventId
        });
        event = await prisma.revenueAIOfferEvent.create({
          data: {
            id: pending.eventId,
            botId: pending.botId,
            conversationId: pending.conversationId,
            messageId: null,
            sessionId: pending.sessionId,
            offerType: pending.offerType,
            stage: pending.stage,
            suggestedProductId: pending.suggestedProductId,
            baseProductId: pending.baseProductId,
            styleUsed: pending.styleUsed,
            meta: pending.meta ?? null,
            timestamp: new Date(pending.createdAt)
          }
        });
      } catch (err) {
        console.error("[RevenueAI] action failed to persist pending event", err);
        return res.status(500).json({ error: "Failed to persist offer event" });
      }
    } else {
      if (
        parsed.data.suggestedProductId &&
        parsed.data.offerType &&
        parsed.data.stage &&
        parsed.data.style
      ) {
        try {
          console.log("[RevenueAI] action creating offer event from action payload", {
            eventId: parsed.data.eventId,
            suggestedProductId: parsed.data.suggestedProductId
          });
          event = await prisma.revenueAIOfferEvent.create({
            data: {
              id: parsed.data.eventId,
              botId: parsed.data.botId,
              conversationId: parsed.data.conversationId,
              messageId: null,
              sessionId: parsed.data.sessionId ?? null,
              offerType: parsed.data.offerType,
              stage: parsed.data.stage,
              suggestedProductId: parsed.data.suggestedProductId,
              baseProductId: null,
              styleUsed: parsed.data.style,
              meta: parsed.data.meta ?? null,
              timestamp: new Date(clientTs)
            }
          });
        } catch (err) {
          console.error("[RevenueAI] action failed to persist offer event from payload", err);
          return res.status(500).json({ error: "Failed to persist offer event" });
        }
      } else {
        console.warn("[RevenueAI] action missing offer event and insufficient payload", {
          eventId: parsed.data.eventId
        });
        return res.status(404).json({ error: "Offer event not found" });
      }
    }
  }

  if (event && (event.botId !== parsed.data.botId || event.conversationId !== parsed.data.conversationId)) {
    console.warn("[RevenueAI] action event mismatch", {
      eventId: event.id,
      eventBotId: event.botId,
      eventConversationId: event.conversationId,
      botId: parsed.data.botId,
      conversationId: parsed.data.conversationId
    });
    return res.status(400).json({ error: "Offer event mismatch" });
  }

  const sessionId = parsed.data.sessionId || event?.sessionId || "";
  const recommendedProductId = event?.suggestedProductId || "";
  const sourceProductId = event?.baseProductId || "";
  const clientEventId = parsed.data.clientEventId || "";
  const bucket = Math.floor(clientTs / 5000);
  const idempotencyKey = crypto
    .createHash("sha256")
    .update(
      [
        parsed.data.botId,
        sessionId,
        parsed.data.conversationId,
        parsed.data.action,
        recommendedProductId,
        sourceProductId,
        clientEventId,
        String(bucket)
      ].join("|")
    )
    .digest("hex");

  const actionResult = await trackRevenueAIAction({
    eventId: parsed.data.eventId,
    botId: parsed.data.botId,
    conversationId: parsed.data.conversationId,
    action: parsed.data.action,
    idempotencyKey,
    meta: parsed.data.meta ?? null
  });

  console.log("[RevenueAI] action stored", {
    eventId: parsed.data.eventId,
    action: parsed.data.action,
    deduped: actionResult?.deduped ?? false
  });

  return res.json({ ok: true, deduped: actionResult?.deduped ?? false });
});

export default router;
