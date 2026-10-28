import { describe, expect, it } from "vitest";
import { newOAuthSession, openOAuthCookie, pkceChallenge, safeEqual, sealOAuthCookie } from "@/lib/oauth";

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("creates a verifier within the allowed 43-128 length and url-safe alphabet", () => {
    const s = newOAuthSession();
    expect(s.verifier.length).toBeGreaterThanOrEqual(43);
    expect(s.verifier.length).toBeLessThanOrEqual(128);
    expect(s.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.challenge).toBe(pkceChallenge(s.verifier));
  });
  it("never repeats state or verifier", () => {
    const a = newOAuthSession();
    const b = newOAuthSession();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("sealed OAuth cookie", () => {
  const payload = { state: "st", verifier: "ver", userId: "u1", createdAt: Date.now() };
  it("round-trips and does not expose the verifier", () => {
    const sealed = sealOAuthCookie(payload);
    expect(sealed).not.toContain("ver");
    expect(openOAuthCookie(sealed)).toMatchObject({ state: "st", verifier: "ver", userId: "u1" });
  });
  it("rejects tampering", () => {
    const sealed = sealOAuthCookie(payload);
    expect(openOAuthCookie(sealed.slice(0, -4) + "AAAA")).toBeNull();
  });
  it("rejects missing, garbage and expired cookies", () => {
    expect(openOAuthCookie(undefined)).toBeNull();
    expect(openOAuthCookie("garbage")).toBeNull();
    expect(openOAuthCookie(sealOAuthCookie(payload), payload.createdAt + 11 * 60 * 1000)).toBeNull();
  });
});

describe("safeEqual", () => {
  it("compares strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
