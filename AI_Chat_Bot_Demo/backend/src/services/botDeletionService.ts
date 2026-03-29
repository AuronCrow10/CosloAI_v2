import { Prisma } from "@prisma/client";

export async function deleteBotsGraph(
  tx: Prisma.TransactionClient,
  botIds: string[]
): Promise<void> {
  if (botIds.length === 0) return;

  const botIdIn = { in: botIds };
  const byBot = { botId: botIdIn };
  const byConversationBot = { conversation: { botId: botIdIn } };

  // Conversation-linked rows that can block conversation deletion.
  await tx.revenueAIOfferAction.deleteMany({ where: byBot });
  await tx.revenueAIOfferEvent.deleteMany({ where: byBot });
  await tx.revenueAISession.deleteMany({ where: byBot });
  await tx.revenueAIStyleOverrideAudit.deleteMany({ where: byBot });
  await tx.revenueAIStyleOverride.deleteMany({ where: byBot });
  await tx.conversationEval.deleteMany({ where: byConversationBot });
  await tx.message.deleteMany({ where: byConversationBot });
  await tx.conversation.deleteMany({ where: byBot });

  // Billing/referral dependencies.
  await tx.referralCommission.deleteMany({ where: byBot });
  await tx.referralAttribution.deleteMany({ where: byBot });

  // Other bot-linked records.
  await tx.planUsageAlert.deleteMany({ where: byBot });
  await tx.teamMembership.deleteMany({ where: byBot });
  await tx.teamInviteBot.deleteMany({ where: byBot });
  await tx.metaLead.deleteMany({ where: byBot });
  await tx.metaLeadAutomation.deleteMany({ where: byBot });
  await tx.metaConnectSession.deleteMany({ where: byBot });
  await tx.whatsappConnectSession.deleteMany({ where: byBot });
  await tx.botChannel.deleteMany({ where: byBot });
  await tx.emailUsage.deleteMany({ where: byBot });
  await tx.openAIUsage.deleteMany({ where: byBot });
  await tx.booking.deleteMany({ where: byBot });
  await tx.bookingService.deleteMany({ where: byBot });
  await tx.shoppingSessionState.deleteMany({ where: byBot });
  await tx.shopifyClerkState.deleteMany({ where: byBot });
  await tx.shopCatalogContext.deleteMany({ where: byBot });
  await tx.shopCatalogSchema.deleteMany({ where: byBot });
  await tx.payment.deleteMany({ where: byBot });
  await tx.subscription.deleteMany({ where: byBot });

  // Shopify keeps history even if bot is deleted.
  await tx.shopifyShop.updateMany({
    where: byBot,
    data: { botId: null }
  });

  await tx.bot.deleteMany({ where: { id: botIdIn } });
}
