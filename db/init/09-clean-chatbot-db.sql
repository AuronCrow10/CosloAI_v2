\connect chatbot

-- =========================
-- REFERRALS
-- =========================
DELETE FROM "ReferralClick";
DELETE FROM "ReferralCommission";
DELETE FROM "ReferralAttribution";
DELETE FROM "ReferralPayoutPeriod";
DELETE FROM "ReferralCode";
DELETE FROM "ReferralPartner";

-- =========================
-- BOOKING / EMAIL USAGE / META LEADS
-- =========================
DELETE FROM "Booking";
DELETE FROM "EmailUsage";
DELETE FROM "MetaLeadAutomation";
DELETE FROM "MetaLead";

-- =========================
-- CONVERSATIONS & MESSAGES
-- =========================
DELETE FROM "Message";
DELETE FROM "ConversationEval";
DELETE FROM "Conversation";

-- =========================
-- BOT-RELATED SESSIONS / CHANNELS / USAGE / PAYMENTS / SUBSCRIPTIONS
-- =========================
DELETE FROM "BotChannel";
DELETE FROM "MetaConnectSession";
DELETE FROM "WhatsappConnectSession";
DELETE FROM "OpenAIUsage";
DELETE FROM "Payment";
DELETE FROM "Subscription";

-- =========================
-- USER TOKENS / MFA
-- =========================
DELETE FROM "MfaBackupCode";
DELETE FROM "RefreshToken";
DELETE FROM "EmailVerificationToken";

-- =========================
-- MAIN ENTITIES
-- =========================
DELETE FROM "Bot";
DELETE FROM "UsagePlan";
DELETE FROM "FeaturePrice";
DELETE FROM "User";
