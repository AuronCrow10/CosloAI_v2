import { RouterResult } from "./conversationRouter";
import { ShoppingState, shouldAvoidRefetch } from "./shoppingStateService";

export function evaluateClerkEligibility(
  router: RouterResult | null,
  state: ShoppingState
): { useClerk: boolean; reason: string } {
  if (!router) return { useClerk: false, reason: "router_missing" };
  const hasShortlist = state.shortlist.length > 0;
  const intent = router.intent;

  if (
    router.route === "SUPPORT" ||
    router.route === "ORDER_STATUS" ||
    router.route === "TOOLS"
  ) {
    return { useClerk: false, reason: "support_route" };
  }
  if (router.switch_product_type) {
    return { useClerk: true, reason: "switch_product_type" };
  }
  if (intent === "HESITATE" || intent === "COMPARE" || intent === "FEEDBACK") {
    return { useClerk: false, reason: "hesitate_compare_feedback" };
  }
  const hasPendingAttribute =
    Boolean(state.filters?.["__range_prompted"]) ||
    Boolean(state.filters?.["__last_question_attr"]);
  if (hasPendingAttribute) {
    return { useClerk: true, reason: "pending_attribute" };
  }
  if (
    !hasShortlist &&
    intent === "QUALIFY" &&
    state.prevIntent === "QUALIFY"
  ) {
    return { useClerk: true, reason: "qualify_repeat" };
  }
  if (intent === "SELECT" || intent === "DETAILS") {
    const hasActiveContext =
      hasShortlist ||
      !!state.activeProductType ||
      Object.keys(state.filters || {}).length > 0;
    return { useClerk: hasActiveContext, reason: "selection_or_details" };
  }
  if (router.route === "CONVERSE" || !router.should_fetch_catalog) {
    return { useClerk: false, reason: "converse_or_no_fetch" };
  }
  if (router.route === "CLERK" || router.should_fetch_catalog) {
    return { useClerk: true, reason: "router_requested" };
  }
  return { useClerk: false, reason: "default" };
}
