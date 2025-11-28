"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleClient = void 0;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.signAccessToken = signAccessToken;
exports.signRefreshToken = signRefreshToken;
exports.verifyAccessToken = verifyAccessToken;
exports.verifyRefreshToken = verifyRefreshToken;
exports.createRefreshToken = createRefreshToken;
exports.revokeRefreshToken = revokeRefreshToken;
exports.sendVerificationEmail = sendVerificationEmail;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = require("crypto");
const date_fns_1 = require("date-fns");
const nodemailer_1 = __importDefault(require("nodemailer"));
const google_auth_library_1 = require("google-auth-library");
const prisma_1 = require("../prisma/prisma");
const config_1 = require("../config");
const SALT_ROUNDS = 10;
async function hashPassword(raw) {
    return bcryptjs_1.default.hash(raw, SALT_ROUNDS);
}
async function verifyPassword(raw, hash) {
    return bcryptjs_1.default.compare(raw, hash);
}
function signAccessToken(payload) {
    return jsonwebtoken_1.default.sign(payload, config_1.config.jwtAccessSecret, {
        expiresIn: config_1.config.jwtAccessExpiresIn
    });
}
function signRefreshToken(payload) {
    return jsonwebtoken_1.default.sign(payload, config_1.config.jwtRefreshSecret, {
        expiresIn: config_1.config.jwtRefreshExpiresIn
    });
}
function verifyAccessToken(token) {
    return jsonwebtoken_1.default.verify(token, config_1.config.jwtAccessSecret);
}
function verifyRefreshToken(token) {
    return jsonwebtoken_1.default.verify(token, config_1.config.jwtRefreshSecret);
}
async function createRefreshToken(userId) {
    const token = (0, crypto_1.randomBytes)(48).toString("hex");
    const expiresAt = (0, date_fns_1.addSeconds)(new Date(), config_1.config.jwtRefreshExpiresIn);
    await prisma_1.prisma.refreshToken.create({
        data: { userId, token, expiresAt }
    });
    return token;
}
async function revokeRefreshToken(token) {
    await prisma_1.prisma.refreshToken.deleteMany({ where: { token } });
}
async function sendVerificationEmail(userId, email) {
    if (!config_1.config.smtpHost || !config_1.config.smtpFrom) {
        console.warn("SMTP not configured, skipping verification email send");
        return;
    }
    const token = (0, crypto_1.randomBytes)(32).toString("hex");
    const expiresAt = (0, date_fns_1.addSeconds)(new Date(), 60 * 60 * 24); // 24h
    await prisma_1.prisma.emailVerificationToken.create({
        data: { userId, token, expiresAt }
    });
    const verifyUrl = `${process.env.FRONTEND_ORIGIN || "http://localhost:3000"}/verify-email?token=${token}`;
    const transporter = nodemailer_1.default.createTransport({
        host: config_1.config.smtpHost,
        port: config_1.config.smtpPort || 587,
        secure: false,
        auth: config_1.config.smtpUser && config_1.config.smtpPassword
            ? { user: config_1.config.smtpUser, pass: config_1.config.smtpPassword }
            : undefined
    });
    await transporter.sendMail({
        from: config_1.config.smtpFrom,
        to: email,
        subject: "Verify your email",
        text: `Click to verify your email: ${verifyUrl}`,
        html: `<p>Click to verify your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`
    });
}
exports.googleClient = config_1.config.googleClientId && config_1.config.googleClientSecret
    ? new google_auth_library_1.OAuth2Client(config_1.config.googleClientId)
    : null;
