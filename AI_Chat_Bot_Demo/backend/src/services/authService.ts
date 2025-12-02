import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import { addSeconds } from "date-fns";
import nodemailer from "nodemailer";
import { OAuth2Client } from "google-auth-library";

import { prisma } from "../prisma/prisma";
import { config } from "../config";

const SALT_ROUNDS = 10;

export interface JwtPayload {
  sub: string;
  role: "ADMIN" | "CLIENT";
}

export async function hashPassword(raw: string): Promise<string> {
  return bcrypt.hash(raw, SALT_ROUNDS);
}

export async function verifyPassword(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtAccessSecret, {
    expiresIn: config.jwtAccessExpiresIn
  });
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtAccessSecret) as JwtPayload;
}

/**
 * Opaque refresh token (random string stored in DB).
 * No JWT for refresh – easier revocation/rotation.
 */
export async function createRefreshToken(userId: string): Promise<string> {
  const token = randomBytes(48).toString("hex");
  const expiresAt = addSeconds(new Date(), config.jwtRefreshExpiresIn);

  await prisma.refreshToken.create({
    data: { userId, token, expiresAt }
  });

  return token;
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { token } });
}

export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

export async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  if (!config.smtpHost || !config.smtpFrom) {
    console.warn("SMTP not configured, skipping verification email send");
    return;
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = addSeconds(new Date(), 60 * 60 * 24); // 24h

  await prisma.emailVerificationToken.create({
    data: { userId, token, expiresAt }
  });

  const verifyUrl = `${
    process.env.FRONTEND_ORIGIN || "http://localhost:3000"
  }/verify-email?token=${token}`;

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort || 587,
    secure: false,
    auth:
      config.smtpUser && config.smtpPassword
        ? { user: config.smtpUser, pass: config.smtpPassword }
        : undefined
  });

  await transporter.sendMail({
    from: config.smtpFrom!,
    to: email,
    subject: "Verify your email",
    text: `Click to verify your email: ${verifyUrl}`,
    html: `<p>Click to verify your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`
  });
}

export const googleClient =
  config.googleClientId && config.googleClientSecret
    ? new OAuth2Client(config.googleClientId)
    : null;
