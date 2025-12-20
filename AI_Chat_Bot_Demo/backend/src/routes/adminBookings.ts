// src/routes/adminBookings.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const BOT_STATUS_VALUES = ["DRAFT", "PENDING_PAYMENT", "ACTIVE", "SUSPENDED", "CANCELED"] as const;
type BotStatus = (typeof BOT_STATUS_VALUES)[number];

function parsePositiveInt(value: unknown, defaultValue: number, max: number): number {
  if (typeof value !== "string") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(n, max);
}

function parseDateOnly(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

type AdminBookingListItem = {
  id: string;

  bot: {
    id: string;
    name: string;
    slug: string;
    status: BotStatus;
    timeZone: string | null;
    owner: {
      id: string;
      email: string;
      name: string | null;
    };
  };

  name: string;
  email: string;
  phone: string;
  service: string;

  start: string;
  end: string;
  timeZone: string;
  calendarId: string;
  calendarEventId: string | null;

  reminderEmailSentAt: string | null;
  createdAt: string;

  bookingConfig: {
    bookingReminderEmailEnabled: boolean;
    bookingConfirmationEmailEnabled: boolean;
    bookingReminderWindowHours: number | null;
    bookingReminderMinLeadHours: number | null;
  };
};

type AdminBookingListResponse = {
  items: AdminBookingListItem[];
  page: number;
  pageSize: number;
  total: number;
};

/**
 * GET /api/admin/bookings
 *
 * Query params:
 *  - q?: string (search in booking name / email / phone / service)
 *  - dateFrom?: string (YYYY-MM-DD)
 *  - dateTo?: string (YYYY-MM-DD)
 *  - onlyUpcoming?: "true" | "false"
 *  - page?: number (1-based, default 1)
 *  - pageSize?: number (default 20, max 100)
 */
router.get("/admin/bookings", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { q, dateFrom, dateTo, onlyUpcoming } = req.query as {
      q?: string;
      dateFrom?: string;
      dateTo?: string;
      onlyUpcoming?: string;
      page?: string;
      pageSize?: string;
    };

    const page = parsePositiveInt(req.query.page, 1, 1000);
    const pageSize = parsePositiveInt(req.query.pageSize, 20, 100);
    const skip = (page - 1) * pageSize;

    const where: any = {};

    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" as const } },
        { email: { contains: term, mode: "insensitive" as const } },
        { phone: { contains: term, mode: "insensitive" as const } },
        { service: { contains: term, mode: "insensitive" as const } },
        {
          bot: {
            OR: [
              { name: { contains: term, mode: "insensitive" as const } },
              { slug: { contains: term, mode: "insensitive" as const } },
              { user: { email: { contains: term, mode: "insensitive" as const } } }
            ]
          }
        }
      ];
    }

    const startFilter: any = {};
    const fromDate = dateFrom ? parseDateOnly(String(dateFrom)) : null;
    const toDate = dateTo ? parseDateOnly(String(dateTo)) : null;

    if (fromDate) {
      startFilter.gte = fromDate;
    }
    if (toDate) {
      const toPlusOne = new Date(toDate);
      toPlusOne.setDate(toPlusOne.getDate() + 1);
      startFilter.lt = toPlusOne;
    }

    if (onlyUpcoming === "true") {
      const now = new Date();
      if (!startFilter.gte || now > startFilter.gte) {
        startFilter.gte = now;
      }
    }

    if (Object.keys(startFilter).length > 0) {
      where.start = startFilter;
    }

    const [total, bookings] = await Promise.all([
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        orderBy: { start: "desc" },
        skip,
        take: pageSize,
        include: {
          bot: {
            select: {
              id: true,
              name: true,
              slug: true,
              status: true,
              timeZone: true,
              bookingReminderEmailEnabled: true,
              bookingConfirmationEmailEnabled: true,
              bookingReminderWindowHours: true,
              bookingReminderMinLeadHours: true,
              user: {
                select: {
                  id: true,
                  email: true,
                  name: true
                }
              }
            }
          }
        }
      })
    ]);

    if (bookings.length === 0) {
      const empty: AdminBookingListResponse = {
        items: [],
        page,
        pageSize,
        total
      };
      return res.json(empty);
    }

    const items: AdminBookingListItem[] = bookings.map((b) => ({
      id: b.id,
      bot: {
        id: b.bot.id,
        name: b.bot.name,
        slug: b.bot.slug,
        status: b.bot.status as BotStatus,
        timeZone: b.bot.timeZone ?? null,
        owner: {
          id: b.bot.user.id,
          email: b.bot.user.email,
          name: b.bot.user.name ?? null
        }
      },
      name: b.name,
      email: b.email,
      phone: b.phone,
      service: b.service,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      timeZone: b.timeZone,
      calendarId: b.calendarId,
      calendarEventId: b.calendarEventId ?? null,
      reminderEmailSentAt: b.reminderEmailSentAt
        ? b.reminderEmailSentAt.toISOString()
        : null,
      createdAt: b.createdAt.toISOString(),
      bookingConfig: {
        bookingReminderEmailEnabled: b.bot.bookingReminderEmailEnabled,
        bookingConfirmationEmailEnabled: b.bot.bookingConfirmationEmailEnabled,
        bookingReminderWindowHours: b.bot.bookingReminderWindowHours ?? null,
        bookingReminderMinLeadHours: b.bot.bookingReminderMinLeadHours ?? null
      }
    }));

    const response: AdminBookingListResponse = {
      items,
      page,
      pageSize,
      total
    };

    return res.json(response);
  } catch (err) {
    console.error("Error in GET /api/admin/bookings:", err);
    return res.status(500).json({ error: "Failed to load bookings" });
  }
});

export default router;
