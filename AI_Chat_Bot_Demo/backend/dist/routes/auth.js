"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../prisma/prisma");
const authService_1 = require("../services/authService");
const config_1 = require("../config");
const router = (0, express_1.Router)();
const registerSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(8)
});
router.post("/register", async (req, res) => {
    console.log("ciao");
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const existing = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (existing)
        return res.status(400).json({ error: "Email already in use" });
    const passwordHash = await (0, authService_1.hashPassword)(password);
    const user = await prisma_1.prisma.user.create({
        data: {
            email,
            passwordHash,
            role: "CLIENT",
            emailVerified: false
        }
    });
    await (0, authService_1.sendVerificationEmail)(user.id, email);
    return res.status(201).json({ message: "Registered; check your email to verify." });
});
const verifyEmailSchema = zod_1.z.object({
    token: zod_1.z.string()
});
router.post("/verify-email", async (req, res) => {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { token } = parsed.data;
    const record = await prisma_1.prisma.emailVerificationToken.findUnique({ where: { token } });
    if (!record || record.expiresAt < new Date()) {
        return res.status(400).json({ error: "Invalid or expired token" });
    }
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.user.update({
            where: { id: record.userId },
            data: { emailVerified: true }
        }),
        prisma_1.prisma.emailVerificationToken.delete({ where: { id: record.id } })
    ]);
    return res.json({ message: "Email verified" });
});
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string()
});
router.post("/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const user = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
        return res.status(400).json({ error: "Invalid credentials" });
    }
    const ok = await (0, authService_1.verifyPassword)(password, user.passwordHash);
    if (!ok)
        return res.status(400).json({ error: "Invalid credentials" });
    if (!user.emailVerified) {
        // For now, allow but warn
        console.warn("User logging in without verified email", { userId: user.id });
    }
    const payload = { sub: user.id, role: user.role };
    const accessToken = (0, authService_1.signAccessToken)(payload);
    const refreshToken = (0, authService_1.signRefreshToken)(payload);
    await (0, authService_1.createRefreshToken)(user.id);
    return res.json({
        accessToken,
        refreshToken,
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            emailVerified: user.emailVerified
        }
    });
});
const refreshSchema = zod_1.z.object({
    refreshToken: zod_1.z.string()
});
router.post("/refresh", async (req, res) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { refreshToken } = parsed.data;
    const dbToken = await prisma_1.prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!dbToken || dbToken.expiresAt < new Date()) {
        return res.status(401).json({ error: "Invalid refresh token" });
    }
    let payload;
    try {
        payload = (0, authService_1.verifyRefreshToken)(refreshToken);
    }
    catch {
        return res.status(401).json({ error: "Invalid refresh token" });
    }
    const accessToken = (0, authService_1.signAccessToken)({
        sub: payload.sub,
        role: payload.role
    });
    return res.json({ accessToken });
});
const logoutSchema = zod_1.z.object({
    refreshToken: zod_1.z.string()
});
router.post("/logout", async (req, res) => {
    const parsed = logoutSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    await (0, authService_1.revokeRefreshToken)(parsed.data.refreshToken);
    return res.json({ message: "Logged out" });
});
const googleSchema = zod_1.z.object({
    idToken: zod_1.z.string()
});
router.post("/google", async (req, res) => {
    if (!authService_1.googleClient || !config_1.config.googleClientId) {
        return res.status(500).json({ error: "Google OAuth not configured" });
    }
    const parsed = googleSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { idToken } = parsed.data;
    let ticket;
    try {
        ticket = await authService_1.googleClient.verifyIdToken({
            idToken,
            audience: config_1.config.googleClientId
        });
    }
    catch (err) {
        console.error("Google token verification failed", err);
        return res.status(400).json({ error: "Invalid Google token" });
    }
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
        return res.status(400).json({ error: "Invalid Google payload" });
    }
    const googleId = payload.sub;
    const email = payload.email;
    let user = await prisma_1.prisma.user.findUnique({ where: { googleId } });
    if (!user) {
        user = await prisma_1.prisma.user.upsert({
            where: { email },
            update: {
                googleId,
                emailVerified: true
            },
            create: {
                email,
                googleId,
                role: "CLIENT",
                emailVerified: true
            }
        });
    }
    const tokenPayload = { sub: user.id, role: user.role };
    const accessToken = (0, authService_1.signAccessToken)(tokenPayload);
    const refreshToken = (0, authService_1.signRefreshToken)(tokenPayload);
    await (0, authService_1.createRefreshToken)(user.id);
    return res.json({
        accessToken,
        refreshToken,
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            emailVerified: user.emailVerified
        }
    });
});
exports.default = router;
