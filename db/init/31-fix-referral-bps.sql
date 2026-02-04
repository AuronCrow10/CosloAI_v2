-- Set referral partner commission to 800 bps for a specific user email
UPDATE "ReferralPartner" rp
SET "commissionBps" = 800,
    "updatedAt" = NOW()
FROM "User" u
WHERE rp."userId" = u."id"
  AND LOWER(u."email") = LOWER('sordp.marketing@gmail.com');
