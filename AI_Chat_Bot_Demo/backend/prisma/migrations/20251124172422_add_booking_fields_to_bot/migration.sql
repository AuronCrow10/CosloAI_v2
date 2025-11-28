-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "calendarId" TEXT,
ADD COLUMN     "defaultDurationMinutes" INTEGER DEFAULT 30,
ADD COLUMN     "timeZone" TEXT;
