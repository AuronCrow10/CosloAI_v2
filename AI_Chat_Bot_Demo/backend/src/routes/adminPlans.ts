// routes/adminPlans.ts
import { Router } from "express";
import { z } from "zod";
// Adjust relative path if needed (follow your existing routes)
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

/* =========================
   Zod schemas
   ========================= */

const usagePlanCreateSchema = z.object({
  code: z.string().min(1, "Code is required"),
  name: z.string().min(1, "Name is required"),
  description: z.string().max(1000).nullable().optional(),

  monthlyTokens: z
    .number()
    .int()
    .min(0, "monthlyTokens must be ≥ 0")
    .nullable()
    .optional(),

  monthlyEmails: z
    .number()
    .int()
    .min(0, "monthlyEmails must be ≥ 0")
    .nullable()
    .optional(),

  monthlyAmountCents: z
    .number()
    .int()
    .min(0, "monthlyAmountCents must be ≥ 0"),

  currency: z.string().min(3).max(3),
  stripePriceId: z.string().max(255).nullable().optional(),
  isActive: z.boolean().optional()
});

const usagePlanUpdateSchema = usagePlanCreateSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "No fields to update"
  });

const featurePriceCreateSchema = z.object({
  code: z.string().min(1, "Code is required"),
  label: z.string().min(1, "Label is required"),
  monthlyAmountCents: z
    .number()
    .int()
    .min(0, "monthlyAmountCents must be ≥ 0"),
  currency: z.string().min(3).max(3),
  stripePriceId: z.string().max(255).nullable().optional(),
  isActive: z.boolean().optional()
});

const featurePriceUpdateSchema = featurePriceCreateSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "No fields to update"
  });

function parseBooleanQuery(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === "string") {
    if (value === "1" || value.toLowerCase() === "true") return true;
    if (value === "0" || value.toLowerCase() === "false") return false;
  }
  return defaultValue;
}

function parseIntQuery(value: unknown, defaultValue: number, min: number, max: number): number {
  if (value === undefined) return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/* =========================
   UsagePlan CRUD
   ========================= */

/**
 * GET /api/admin/plans
 * Query:
 *  - search?: string
 *  - includeInactive?: boolean
 *  - take?: number
 *  - skip?: number
 */
router.get("/admin/plans", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const includeInactive = parseBooleanQuery(req.query.includeInactive, false);
  const take = parseIntQuery(req.query.take, 50, 1, 200);
  const skip = parseIntQuery(req.query.skip, 0, 0, Number.MAX_SAFE_INTEGER);

  const where: any = {};
  if (!includeInactive) {
    where.isActive = true;
  }
  if (search) {
    where.OR = [
      { code: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } }
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.usagePlan.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: { _count: { select: { subscriptions: true } } }
    }),
    prisma.usagePlan.count({ where })
  ]);

  const items = rows.map((p: any) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    monthlyTokens: p.monthlyTokens,
    monthlyEmails: p.monthlyEmails,
    monthlyAmountCents: p.monthlyAmountCents,
    currency: p.currency,
    stripePriceId: p.stripePriceId,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    subscriptionsCount: p._count?.subscriptions ?? 0
  }));

  return res.json({ items, total });
});

/**
 * GET /api/admin/plans/:id
 */
router.get("/admin/plans/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { id } = req.params;

  const p: any = await prisma.usagePlan.findUnique({
    where: { id },
    include: { _count: { select: { subscriptions: true } } }
  });

  if (!p) return res.status(404).json({ error: "Usage plan not found" });

  return res.json({
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    monthlyTokens: p.monthlyTokens,
    monthlyEmails: p.monthlyEmails,
    monthlyAmountCents: p.monthlyAmountCents,
    currency: p.currency,
    stripePriceId: p.stripePriceId,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    subscriptionsCount: p._count?.subscriptions ?? 0
  });
});

/**
 * POST /api/admin/plans
 */
router.post("/admin/plans", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = usagePlanCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const {
    code,
    name,
    description,
    monthlyTokens,
    monthlyEmails,
    monthlyAmountCents,
    currency,
    stripePriceId,
    isActive
  } = parsed.data;

  try {
    const created = await prisma.usagePlan.create({
      data: {
        code: code.trim(),
        name: name.trim(),
        description: description ? description.trim() : null,
        monthlyTokens: monthlyTokens ?? null,
        monthlyEmails: monthlyEmails ?? null,
        monthlyAmountCents,
        currency: currency.toLowerCase(),
        stripePriceId: stripePriceId ? stripePriceId.trim() : null,
        isActive: isActive ?? true
      }
    });

    return res.status(201).json(created);
  } catch (err: any) {
    if (err && typeof err === "object" && (err as any).code === "P2002") {
      // Unique constraint (likely code)
      return res.status(409).json({ error: "Usage plan code must be unique" });
    }
    console.error("Error creating usage plan", err);
    return res.status(500).json({ error: "Failed to create usage plan" });
  }
});

/**
 * PATCH /api/admin/plans/:id
 */
router.patch("/admin/plans/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { id } = req.params;
  const parsed = usagePlanUpdateSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;

  const updateData: any = {};
  if (typeof data.code === "string") updateData.code = data.code.trim();
  if (typeof data.name === "string") updateData.name = data.name.trim();
  if (data.description !== undefined) {
    updateData.description =
      data.description && data.description.trim().length > 0
        ? data.description.trim()
        : null;
  }
  if (data.monthlyTokens !== undefined) updateData.monthlyTokens = data.monthlyTokens;
  if (data.monthlyEmails !== undefined) updateData.monthlyEmails = data.monthlyEmails;
  if (typeof data.monthlyAmountCents === "number") {
    updateData.monthlyAmountCents = data.monthlyAmountCents;
  }
  if (typeof data.currency === "string") {
    updateData.currency = data.currency.toLowerCase();
  }
  if (data.stripePriceId !== undefined) {
    updateData.stripePriceId =
      data.stripePriceId && data.stripePriceId.trim().length > 0
        ? data.stripePriceId.trim()
        : null;
  }
  if (typeof data.isActive === "boolean") updateData.isActive = data.isActive;

  try {
    const updated = await prisma.usagePlan.update({
      where: { id },
      data: updateData
    });

    return res.json(updated);
  } catch (err: any) {
    if (err && typeof err === "object" && (err as any).code === "P2002") {
      return res.status(409).json({ error: "Usage plan code must be unique" });
    }
    console.error("Error updating usage plan", err);
    return res.status(500).json({ error: "Failed to update usage plan" });
  }
});

/**
 * DELETE /api/admin/plans/:id
 * - Refuses to delete if plan is referenced by any Subscription
 */
router.delete("/admin/plans/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { id } = req.params;

  const plan = await prisma.usagePlan.findUnique({ where: { id } });
  if (!plan) return res.status(404).json({ error: "Usage plan not found" });

  const subscriptionCount = await prisma.subscription.count({
    where: { usagePlanId: id }
  });

  if (subscriptionCount > 0) {
    return res.status(400).json({
      error: "Cannot delete a usage plan that has subscriptions. Set isActive=false instead."
    });
  }

  await prisma.usagePlan.delete({ where: { id } });
  return res.json({ ok: true });
});

/* =========================
   FeaturePrice CRUD (legacy)
   ========================= */

/**
 * GET /api/admin/feature-prices
 * Query:
 *  - search?: string
 *  - includeInactive?: boolean
 */
router.get(
  "/admin/feature-prices",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const includeInactive = parseBooleanQuery(req.query.includeInactive, false);

    const where: any = {};
    if (!includeInactive) where.isActive = true;
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { label: { contains: search, mode: "insensitive" } }
      ];
    }

    const items = await prisma.featurePrice.findMany({
      where,
      orderBy: { createdAt: "desc" }
    });

    return res.json({ items, total: items.length });
  }
);

/**
 * GET /api/admin/feature-prices/:id
 */
router.get(
  "/admin/feature-prices/:id",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const { id } = req.params;
    const fp = await prisma.featurePrice.findUnique({ where: { id } });
    if (!fp) return res.status(404).json({ error: "Feature price not found" });
    return res.json(fp);
  }
);

/**
 * POST /api/admin/feature-prices
 */
router.post(
  "/admin/feature-prices",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const parsed = featurePriceCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { code, label, monthlyAmountCents, currency, stripePriceId, isActive } =
      parsed.data;

    try {
      const created = await prisma.featurePrice.create({
        data: {
          code: code.trim(),
          label: label.trim(),
          monthlyAmountCents,
          currency: currency.toLowerCase(),
          stripePriceId: stripePriceId ? stripePriceId.trim() : null,
          isActive: isActive ?? true
        }
      });

      return res.status(201).json(created);
    } catch (err: any) {
      if (err && typeof err === "object" && (err as any).code === "P2002") {
        return res.status(409).json({ error: "Feature price code must be unique" });
      }
      console.error("Error creating feature price", err);
      return res.status(500).json({ error: "Failed to create feature price" });
    }
  }
);

/**
 * PATCH /api/admin/feature-prices/:id
 */
router.patch(
  "/admin/feature-prices/:id",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const { id } = req.params;
    const parsed = featurePriceUpdateSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const data = parsed.data;

    const updateData: any = {};
    if (typeof data.code === "string") updateData.code = data.code.trim();
    if (typeof data.label === "string") updateData.label = data.label.trim();
    if (typeof data.monthlyAmountCents === "number") {
      updateData.monthlyAmountCents = data.monthlyAmountCents;
    }
    if (typeof data.currency === "string") {
      updateData.currency = data.currency.toLowerCase();
    }
    if (data.stripePriceId !== undefined) {
      updateData.stripePriceId =
        data.stripePriceId && data.stripePriceId.trim().length > 0
          ? data.stripePriceId.trim()
          : null;
    }
    if (typeof data.isActive === "boolean") updateData.isActive = data.isActive;

    try {
      const updated = await prisma.featurePrice.update({
        where: { id },
        data: updateData
      });

      return res.json(updated);
    } catch (err: any) {
      if (err && typeof err === "object" && (err as any).code === "P2002") {
        return res.status(409).json({ error: "Feature price code must be unique" });
      }
      console.error("Error updating feature price", err);
      return res.status(500).json({ error: "Failed to update feature price" });
    }
  }
);

/**
 * DELETE /api/admin/feature-prices/:id
 */
router.delete(
  "/admin/feature-prices/:id",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const { id } = req.params;

    const fp = await prisma.featurePrice.findUnique({ where: { id } });
    if (!fp) return res.status(404).json({ error: "Feature price not found" });

    await prisma.featurePrice.delete({ where: { id } });
    return res.json({ ok: true });
  }
);

export default router;
