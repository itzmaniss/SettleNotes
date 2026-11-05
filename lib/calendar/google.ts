import type { CalendarEventBody } from "./event";

export type GoogleErrorKind = "auth" | "gone" | "rate" | "server" | "other";

// Typed Google failure. Messages carry only the op and status, never tokens,
// response bodies or anything that could leak credentials into logs.
export class GoogleError extends Error {
  readonly kind: GoogleErrorKind;
  readonly status: number;

  constructor(kind: GoogleErrorKind, status: number, op: string) {
    super(`google ${op} failed (kind ${kind}, http ${status})`);
    this.name = "GoogleError";
    this.kind = kind;
    this.status = status;
  }
}

export type AccessToken = {
  accessToken: string;
  expiresIn: number;
};

export type ExchangeCodeInput = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

export type ExchangeCodeResult = {
  accessToken: string;
  // Null when Google does not return one (repeat consent). The callback
  // treats that as an error redirect, never as a connection.
  refreshToken: string | null;
};

export type GoogleCalendarClient = {
  refreshAccessToken(refreshToken: string): Promise<AccessToken>;
  exchangeCode(input: ExchangeCodeInput): Promise<ExchangeCodeResult>;
  revokeToken(token: string): Promise<void>;
  createCalendar(accessToken: string, name: string): Promise<{ id: string }>;
  deleteCalendar(accessToken: string, calendarId: string): Promise<void>;
  getCalendarExists(accessToken: string, calendarId: string): Promise<boolean>;
  insertEvent(
    accessToken: string,
    calendarId: string,
    event: CalendarEventBody
  ): Promise<{ id: string }>;
  patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: CalendarEventBody
  ): Promise<void>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
};

export type CreateGoogleClientInput = {
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/calendar/v3";

function classifyStatus(status: number, bodyText: string): GoogleErrorKind {
  if (status === 401 || bodyText.includes("invalid_grant")) return "auth";
  if (status === 404 || status === 410) return "gone";
  if (status === 429) return "rate";
  if (status === 403) {
    if (
      bodyText.includes("rateLimitExceeded") ||
      bodyText.includes("userRateLimitExceeded") ||
      bodyText.includes("quotaExceeded") ||
      bodyText.includes("dailyLimitExceeded")
    ) {
      return "rate";
    }
    if (
      bodyText.includes("insufficientPermissions") ||
      bodyText.includes("insufficient authentication scopes")
    ) {
      return "auth";
    }
    return "other";
  }
  if (status >= 500) return "server";
  return "other";
}

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export function createGoogleClient(input: CreateGoogleClientInput): GoogleCalendarClient {
  const fetchFn = input.fetch;

  async function callApi(
    op: string,
    accessToken: string,
    path: string,
    init?: RequestInit
  ): Promise<{ status: number; bodyText: string }> {
    let res: Response;
    try {
      res = await fetchFn(`${API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
    } catch {
      throw new GoogleError("server", 0, op);
    }
    const bodyText = await res.text();
    if (!res.ok) throw new GoogleError(classifyStatus(res.status, bodyText), res.status, op);
    return { status: res.status, bodyText };
  }

  return {
    async refreshAccessToken(refreshToken: string): Promise<AccessToken> {
      const op = "refreshAccessToken";
      let res: Response;
      try {
        res = await fetchFn(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }).toString(),
        });
      } catch {
        throw new GoogleError("server", 0, op);
      }
      const bodyText = await res.text();
      if (!res.ok) {
        const status = res.status;
        throw new GoogleError(classifyStatus(status, bodyText), status, op);
      }
      const parsed = JSON.parse(bodyText) as { access_token?: unknown; expires_in?: unknown };
      if (typeof parsed.access_token !== "string") {
        throw new GoogleError("other", res.status, op);
      }
      return {
        accessToken: parsed.access_token,
        expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : 0,
      };
    },

    async exchangeCode(code: ExchangeCodeInput): Promise<ExchangeCodeResult> {
      const op = "exchangeCode";
      let res: Response;
      try {
        res = await fetchFn(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            code: code.code,
            code_verifier: code.codeVerifier,
            redirect_uri: code.redirectUri,
            grant_type: "authorization_code",
          }).toString(),
        });
      } catch {
        throw new GoogleError("server", 0, op);
      }
      const bodyText = await res.text();
      if (!res.ok) {
        throw new GoogleError(classifyStatus(res.status, bodyText), res.status, op);
      }
      const parsed = JSON.parse(bodyText) as {
        access_token?: unknown;
        refresh_token?: unknown;
      };
      if (typeof parsed.access_token !== "string") {
        throw new GoogleError("other", res.status, op);
      }
      return {
        accessToken: parsed.access_token,
        refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : null,
      };
    },

    // Best effort by design: revocation must never fail a disconnect, so
    // every failure resolves quietly instead of throwing.
    async revokeToken(token: string): Promise<void> {
      try {
        await fetchFn(REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        });
      } catch {
        // unreachable Google or a dropped connection: the token stays valid
        // until it expires, which the disconnect accepts.
      }
    },

    async createCalendar(accessToken: string, name: string): Promise<{ id: string }> {
      const { bodyText } = await callApi("createCalendar", accessToken, "/calendars", {
        method: "POST",
        body: JSON.stringify({ summary: name }),
      });
      const parsed = JSON.parse(bodyText) as { id?: unknown };
      if (typeof parsed.id !== "string") throw new GoogleError("other", 200, "createCalendar");
      return { id: parsed.id };
    },

    async getCalendarExists(accessToken: string, calendarId: string): Promise<boolean> {
      try {
        await callApi("getCalendar", accessToken, `/calendars/${encodeURIComponent(calendarId)}`, {
          method: "GET",
        });
        return true;
      } catch (err) {
        if (err instanceof GoogleError && err.kind === "gone") return false;
        throw err;
      }
    },

    async deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
      await callApi("deleteCalendar", accessToken, `/calendars/${encodeURIComponent(calendarId)}`, {
        method: "DELETE",
      });
    },

    async insertEvent(
      accessToken: string,
      calendarId: string,
      event: CalendarEventBody
    ): Promise<{ id: string }> {
      const { bodyText } = await callApi(
        "insertEvent",
        accessToken,
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: "POST", body: JSON.stringify(event) }
      );
      const parsed = JSON.parse(bodyText) as { id?: unknown };
      if (typeof parsed.id !== "string") throw new GoogleError("other", 200, "insertEvent");
      return { id: parsed.id };
    },

    async patchEvent(
      accessToken: string,
      calendarId: string,
      eventId: string,
      event: CalendarEventBody
    ): Promise<void> {
      await callApi(
        "patchEvent",
        accessToken,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: "PATCH", body: JSON.stringify(event) }
      );
    },

    async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
      await callApi(
        "deleteEvent",
        accessToken,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: "DELETE" }
      );
    },
  };
}
