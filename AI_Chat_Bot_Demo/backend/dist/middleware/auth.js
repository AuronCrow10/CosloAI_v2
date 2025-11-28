"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requireRole = requireRole;
const prisma_1 = require("../prisma/prisma");
const authService_1 = require("../services/authService");
async function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    const token = header.substring("Bearer ".length);
    let payload;
    try {
        payload = (0, authService_1.verifyAccessToken)(token);
    }
    catch {
        return res.status(401).json({ error: "Invalid token" });
    }
    const user = await prisma_1.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user)
        return res.status(401).json({ error: "Unauthorized" });
    req.user = {
        id: user.id,
        email: user.email,
        role: user.role
    };
    return next();
}
function requireRole(role) {
    return (req, res, next) => {
        if (!req.user)
            return res.status(401).json({ error: "Unauthorized" });
        if (req.user.role !== role)
            return res.status(403).json({ error: "Forbidden" });
        return next();
    };
}
