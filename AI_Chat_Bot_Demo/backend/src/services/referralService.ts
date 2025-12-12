import crypto from "crypto";
import { prisma } from "../prisma/prisma";
import { config } from "../config";

export const REFERRAL_COOKIE_NAME = config.referralCookieName;
export const REFERRAL_COOKIE_MAX_AGE_DAYS = config.referralCookieMaxAgeDays;
export const REFERRAL_DEFAULT_COMMISSION_BPS = config.referralDefaultCommissionBps;

const IP_HASH_SALT = config.referralIpHashSalt || "";

export function monthKeyForDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function computeCommissionCents(amountBaseCents: number, commissionBps: number): number {
  return Math.round((amountBaseCents * commissionBps) / 10000);
}

export function generateReferralCode(length = 10): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  if (!IP_HASH_SALT) return null;
  return crypto.createHash("sha256").update(`${IP_HASH_SALT}:${ip}`).digest("hex");
}

export async function validateReferralCode(codeRaw: string) {
  const code = (codeRaw || "").trim().toUpperCase();
  if (!code) return null;

  const record = await prisma.referralCode.findFirst({
    where: {
      code,
      isActive: true,
      partner: { status: "ACTIVE" }
    },
    include: {
      partner: true
    }
  });

  if (!record) return null;

  return {
    code: record.code,
    referralCodeId: record.id,
    partnerId: record.partnerId,
    partnerUserId: record.partner.userId,
    commissionBps: record.partner.commissionBps
  };
}
