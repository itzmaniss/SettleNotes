"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { performAccept, realAcceptDeps } from "@/lib/auth/accept";
import { consentCookieOptions, CONSENT_COOKIE } from "@/lib/auth/consent-cookie";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/jwt";

// Thin server action behind the agree button on /accept. Identity is never
// taken from the form: performAccept re-verifies the consent or session cookie
// and only the navigation hint comes from the hidden field. It ends in exactly
// one redirect, so nothing here returns data.
export async function acceptAgree(formData: FormData): Promise<void> {
  const store = await cookies();
  const deps = realAcceptDeps();
  const rawNext = formData.get("next");
  const outcome = await performAccept(deps, {
    consentToken: store.get(CONSENT_COOKIE)?.value,
    sessionToken: store.get(SESSION_COOKIE)?.value,
    next: typeof rawNext === "string" ? rawNext : null,
  });
  if (outcome.kind === "anonymous") redirect("/login");
  if (outcome.sessionToken !== null) {
    // Same flags as the magic link cookie: flags follow the origin scheme.
    store.set(SESSION_COOKIE, outcome.sessionToken, sessionCookieOptions(deps.appBaseUrl));
  }
  if (outcome.clearConsentCookie) {
    // Max-Age=0 is how a cookie is actually removed across browsers.
    store.set(CONSENT_COOKIE, "", { ...consentCookieOptions(deps.appBaseUrl), maxAge: 0 });
  }
  redirect(outcome.location);
}
