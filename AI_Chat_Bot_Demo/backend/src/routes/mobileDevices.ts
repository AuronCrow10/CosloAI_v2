// routes/mobileDevices.ts
import { Router, Request, Response } from "express";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.post(
  "/mobile/devices",
  requireAuth,
  async (req: Request, res: Response) => {
    const { expoPushToken, platform } = req.body as {
      expoPushToken?: string;
      platform?: "ios" | "android";
    };

    if (!expoPushToken || !platform) {
      return res
        .status(400)
        .json({ error: "expoPushToken and platform are required." });
    }

    await prisma.mobileDevice.upsert({
      where: { expoPushToken },
      update: { platform, userId: req.user!.id },
      create: {
        expoPushToken,
        platform,
        userId: req.user!.id
      }
    });

    return res.status(204).send();
  }
);

export default router;
