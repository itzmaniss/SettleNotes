"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { requireSessionUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/queries";
import {
  performDeleteAccount,
  performLogOut,
  realDeleteAccountDeps,
  type AccountActionDeps,
} from "@/lib/account/delete";

// The Account page actions: thin wrappers whose real bodies live in
// lib/account/delete.ts with injected deps, so tests run without module
// mocks. The user id always comes from the signed session, never from the
// form, and real deps are built lazily inside the action, never at import
// time. Each action ends in exactly one redirect, so nothing returns data.

function realActionDeps(): AccountActionDeps {
  return {
    session: async () => (await requireSessionUser()).userId,
    getUser: getUserById,
    deletion: realDeleteAccountDeps(),
    cookies,
    baseUrl: () => env.APP_BASE_URL,
    redirectTo: redirect,
  };
}

export async function logOut(): Promise<void> {
  return performLogOut(realActionDeps());
}

export async function deleteAccount(formData: FormData): Promise<void> {
  return performDeleteAccount(realActionDeps(), formData);
}
