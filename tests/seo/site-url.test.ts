import { describe, expect, test } from "bun:test";
import { siteUrl } from "@/lib/seo/site";

const FALLBACK = "https://settlenotes.com/";

type Case = { name: string; raw: string | undefined; want: string };

const cases: Case[] = [
  { name: "undefined falls back", raw: undefined, want: FALLBACK },
  { name: "blank falls back", raw: "", want: FALLBACK },
  { name: "whitespace only falls back", raw: "   ", want: FALLBACK },
  { name: "not a url falls back", raw: "almost a url", want: FALLBACK },
  { name: "http localhost falls back", raw: "http://localhost:3000", want: FALLBACK },
  { name: "http loopback with a path falls back", raw: "http://127.0.0.1:3000/dashboard", want: FALLBACK },
  { name: "a path is stripped", raw: "https://settlenotes.com/blog/post", want: FALLBACK },
  { name: "trailing slash and query are stripped", raw: "https://settlenotes.com/?utm=x/", want: FALLBACK },
  { name: "a non web scheme falls back", raw: "ftp://settlenotes.com", want: FALLBACK },
  { name: "an uppercase host and path still land on the origin", raw: "HTTPS://SETTLENOTES.COM/Blog", want: FALLBACK },
  {
    name: "another https origin is kept, port included",
    raw: "https://preview.settlenotes.com:8443/x",
    want: "https://preview.settlenotes.com:8443/",
  },
  {
    name: "a non local http origin is kept as given",
    raw: "http://staging.example.com/",
    want: "http://staging.example.com/",
  },
];

describe("siteUrl", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(siteUrl(c.raw).toString()).toBe(c.want);
    });
  }

  test("returns a fresh URL each call, never a shared object", () => {
    const a = siteUrl("https://settlenotes.com");
    const b = siteUrl("https://settlenotes.com");
    expect(a).not.toBe(b);
    expect(a.toString()).toBe(b.toString());
  });
});
