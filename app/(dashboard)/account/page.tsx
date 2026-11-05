import type { Metadata } from "next";
import { requireSessionUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/queries";
import { isBillingEnabled } from "@/lib/billing/flags";
import { getPlanForUser } from "@/lib/billing/entitlements";
import { PLANS, type PlanId } from "@/lib/billing/plans";
import { buildAccountPageView } from "@/lib/account/view";
import { AccountPanel } from "@/components/account/account-panel";
import { isCalendarSyncEnabled } from "@/lib/calendar/flags";
import { getConnection } from "@/lib/calendar/queries";
import { buildCalendarView, type CalendarView } from "@/lib/calendar/view";
import { deleteAccount, logOut } from "./actions";

export const metadata: Metadata = {
  title: "Your account",
};

type SearchParams = {
  status?: string | string[];
  kind?: string | string[];
  calendar?: string | string[];
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Server half of /account: loads the name and plan, then hands plain data to
// the panel. Protected twice, like /billing: middleware redirects signed-out
// visitors, and requireSessionUser fails closed for the data reads (a session
// whose user row is gone, for example after deletion, is expired).
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { userId } = await requireSessionUser();
  const [row, params] = await Promise.all([getUserById(userId), searchParams]);

  const billingEnabled = isBillingEnabled();
  let plan: PlanId = billingEnabled ? "free" : "pro";
  try {
    plan = billingEnabled ? await getPlanForUser(userId) : "pro";
  } catch {
    // A broken ledger must not take the page down; the plan shows Free.
  }

  const view = buildAccountPageView({
    firstName: row?.first_name ?? null,
    planName: PLANS[plan].name,
    status: firstParam(params.status),
    cancelKind: firstParam(params.kind),
  });

  let calendar: CalendarView | null = null;
  if (isCalendarSyncEnabled()) {
    let status: "active" | "needs_reconnect" | null = null;
    try {
      status = (await getConnection(userId))?.status ?? null;
    } catch {
      // A failed read hides the block state, never the page.
      status = null;
    }
    calendar = buildCalendarView({
      isPro: plan === "pro",
      status,
      banner: firstParam(params.calendar),
    });
  }

  return <AccountPanel view={view} logOut={logOut} deleteAccount={deleteAccount} calendar={calendar} />;
}
