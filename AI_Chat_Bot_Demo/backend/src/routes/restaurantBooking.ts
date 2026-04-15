import { Router, Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { userCanAccessBot } from "../services/teamAccessService";
import {
  cancelRestaurantReservation,
  checkInRestaurantReservation,
  completeRestaurantReservation,
  createManualRestaurantReservation,
  getCheckInReservationForToken,
  getRestaurantDashboard,
  getRestaurantSetup,
  isRestaurantTableCodeUniqueDbError,
  listRestaurantReservations,
  markNoShowRestaurantReservation,
  RestaurantSetupValidationError,
  saveRestaurantSetup,
  setRestaurantTableManualState
} from "../services/restaurantBookingService";

const router = Router();

// Scope auth to the restaurant routes owned by this router so unrelated
// /api endpoints (for example the public widget chat route) are not intercepted.
router.use("/bots/:id/restaurant", requireAuth);
router.use("/restaurant/check-in/:token", requireAuth);

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

const handleAsync = (handler: AsyncRouteHandler): RequestHandler => {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
};

async function canAccessBot(req: Request, botId: string): Promise<boolean> {
  if (!req.user) return false;
  return userCanAccessBot(req.user, botId);
}

const setupSchema = z.object({
  rules: z
    .object({
      timeZone: z.string().optional().nullable(),
      openingHours: z.any().optional().nullable(),
      closedDates: z.array(z.string()).optional().nullable(),
      defaultDurationMinutes: z.number().int().positive().optional().nullable(),
      bufferMinutes: z.number().int().min(0).optional().nullable(),
      autoBookingSaturationPct: z.number().int().min(1).max(100).optional().nullable(),
      oversizeToleranceSeats: z.number().int().min(0).optional().nullable(),
      allowJoinedTables: z.boolean().optional().nullable(),
      joinedTablesFallbackOnly: z.boolean().optional().nullable(),
      maxJoinedTables: z.number().int().min(1).optional().nullable(),
      lateArrivalGraceMinutes: z.number().int().min(0).optional().nullable(),
      noShowAfterMinutes: z.number().int().min(0).optional().nullable()
    })
    .optional(),
  rooms: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      notes: z.string().optional().nullable(),
      displayOrder: z.number().int().optional().nullable(),
      isActive: z.boolean().optional(),
      tables: z.array(
        z.object({
          id: z.string().optional(),
          code: z.string().min(1),
          capacity: z.number().int().positive(),
          isSmoking: z.boolean().optional(),
          notes: z.string().optional().nullable(),
          isAiBookable: z.boolean().optional(),
          isActive: z.boolean().optional()
        })
      )
    })
  ),
  joins: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      isActive: z.boolean().optional(),
      allowAiBooking: z.boolean().optional(),
      tableIds: z.array(z.string()).min(2)
    })
  )
});

const manualReservationSchema = z.object({
  customerName: z.string().min(1),
  customerEmail: z.string().email(),
  customerPhone: z.string().min(1),
  partySize: z.number().int().positive(),
  datetime: z.string().min(1),
  smokingPreference: z
    .enum(["NO_PREFERENCE", "SMOKING", "NON_SMOKING"])
    .optional(),
  notes: z.string().optional(),
  tableIds: z.array(z.string()).optional()
});

const tableManualStateSchema = z.object({
  manualState: z.enum(["AUTO", "FREE", "RESERVED", "OCCUPIED", "OUT_OF_SERVICE"]),
  note: z.string().optional()
});

router.get("/bots/:id/restaurant/setup", handleAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!(await canAccessBot(req, id))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const setup = await getRestaurantSetup(id);
  if (!setup) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(setup);
}));

router.put("/bots/:id/restaurant/setup", handleAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!(await canAccessBot(req, id))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const updated = await saveRestaurantSetup({
      botId: id,
      input: parsed.data as any,
      actorUserId: req.user!.id
    });
    res.json(updated);
  } catch (error: any) {
    if (error instanceof RestaurantSetupValidationError) {
      return res.status(error.statusCode).json({
        errorCode: error.code,
        error: error.message,
        details: error.details
      });
    }
    if (isRestaurantTableCodeUniqueDbError(error)) {
      return res.status(409).json({
        errorCode: "duplicate_table_code_in_room",
        error:
          "A table code must be unique within the same room. Please rename duplicates and try again."
      });
    }
    throw error;
  }
}));

router.get("/bots/:id/restaurant/dashboard", handleAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!(await canAccessBot(req, id))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const atIso = typeof req.query.at === "string" ? req.query.at : undefined;
  const data = await getRestaurantDashboard({ botId: id, atIso });
  res.json(data);
}));

router.get(
  "/bots/:id/restaurant/reservations",
  handleAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!(await canAccessBot(req, id))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const rows = await listRestaurantReservations({
      botId: id,
      date,
      q,
      status,
      limit
    });
    res.json({ items: rows });
  })
);

router.post(
  "/bots/:id/restaurant/reservations/manual",
  handleAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!(await canAccessBot(req, id))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const parsed = manualReservationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const result = await createManualRestaurantReservation({
      botId: id,
      actorUserId: req.user!.id,
      ...parsed.data
    });
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.status(201).json(result);
  })
);

router.post(
  "/bots/:id/restaurant/reservations/:reservationId/check-in",
  handleAsync(async (req: Request, res: Response) => {
    const { id, reservationId } = req.params;
    if (!(await canAccessBot(req, id))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const result = await checkInRestaurantReservation({
      botId: id,
      reservationId,
      actorUserId: req.user!.id
    });
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  })
);

router.post(
  "/bots/:id/restaurant/reservations/:reservationId/cancel",
  handleAsync(async (req: Request, res: Response) => {
    const { id, reservationId } = req.params;
    if (!(await canAccessBot(req, id))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const reason =
      typeof req.body?.reason === "string" ? String(req.body.reason) : undefined;
    const result = await cancelRestaurantReservation({
      botId: id,
      reservationId,
      actor: "STAFF",
      actorUserId: req.user!.id,
      reason
    });
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  })
);

router.post(
  "/bots/:id/restaurant/reservations/:reservationId/no-show",
  handleAsync(async (req: Request, res: Response) => {
    const { id, reservationId } = req.params;
    if (!(await canAccessBot(req, id))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const result = await markNoShowRestaurantReservation({
      botId: id,
      reservationId,
      actorUserId: req.user!.id
    });
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  })
);

router.post(
  "/bots/:id/restaurant/reservations/:reservationId/complete",
  handleAsync(async (req: Request, res: Response) => {
    const { id, reservationId } = req.params;
    if (!(await canAccessBot(req, id))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const result = await completeRestaurantReservation({
      botId: id,
      reservationId,
      actorUserId: req.user!.id
    });
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  })
);

router.post(
  "/bots/:id/restaurant/tables/:tableId/manual-state",
  handleAsync(async (req: Request, res: Response) => {
    const { id, tableId } = req.params;
    if (!(await canAccessBot(req, id))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const parsed = tableManualStateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const result = await setRestaurantTableManualState({
      botId: id,
      tableId,
      manualState: parsed.data.manualState,
      note: parsed.data.note,
      actorUserId: req.user!.id
    });
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  })
);

router.get("/restaurant/check-in/:token", handleAsync(async (req: Request, res: Response) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).json({ error: "Invalid token" });
  const reservation = await getCheckInReservationForToken({ token });
  if (!reservation) return res.status(404).json({ error: "Not found" });

  if (!(await canAccessBot(req, reservation.bot.id))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const unusableStatuses = new Set(["CANCELLED", "EXPIRED", "NO_SHOW", "COMPLETED"]);
  const unusable = unusableStatuses.has(reservation.status);

  res.json({
    id: reservation.id,
    bot: reservation.bot,
    status: reservation.status,
    customerName: reservation.customerName,
    customerEmail: reservation.customerEmail,
    customerPhone: reservation.customerPhone,
    partySize: reservation.partySize,
    smokingPreference: reservation.smokingPreference,
    notes: reservation.notes,
    startAt: reservation.startAt,
    endAt: reservation.endAt,
    tables: reservation.tables.map((rt: any) => ({
      id: rt.table.id,
      code: rt.table.code,
      roomName: rt.table.room?.name || null,
      role: rt.role
    })),
    unusable,
    canCheckIn: !unusable && (reservation.status === "PENDING" || reservation.status === "CONFIRMED")
  });
}));

router.post(
  "/restaurant/check-in/:token/check-in",
  handleAsync(async (req: Request, res: Response) => {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).json({ error: "Invalid token" });
    const reservation = await getCheckInReservationForToken({ token });
    if (!reservation) return res.status(404).json({ error: "Not found" });
    if (!(await canAccessBot(req, reservation.bot.id))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await checkInRestaurantReservation({
      botId: reservation.bot.id,
      reservationId: reservation.id,
      actorUserId: req.user!.id
    });
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  })
);

export default router;
