import { describe, expect, it } from "vitest";
import { charsRemaining, countChars, countXChars, youtubeTitle } from "@/lib/platforms/length";

describe("countXChars (weighted like X)", () => {
  it("counts plain ASCII 1:1", () => {
    expect(countXChars("hello world")).toBe(11);
  });
  it("counts every URL as 23 regardless of length", () => {
    expect(countXChars("https://example.com/a/very/long/path?with=query&and=more")).toBe(23);
    expect(countXChars("see https://a.co and http://b.co/long/long/long")).toBe(4 + 23 + 5 + 23);
  });
  it("counts emoji and CJK as 2", () => {
    expect(countXChars("hi 🙂")).toBe(3 + 2);
    expect(countXChars("日本語")).toBe(6);
  });
  it("handles an empty string", () => {
    expect(countXChars("")).toBe(0);
  });
});

describe("per-platform counting", () => {
  it("uses weighted counting for X and code points elsewhere", () => {
    expect(countChars("twitter", "https://example.com/long/long/long")).toBe(23);
    expect(countChars("linkedin", "https://example.com")).toBe(19);
    expect(countChars("linkedin", "🙂")).toBe(1);
  });
  it("reports remaining characters (negative when over)", () => {
    expect(charsRemaining("twitter", "a".repeat(280))).toBe(0);
    expect(charsRemaining("twitter", "a".repeat(285))).toBe(-5);
    expect(charsRemaining("bluesky", "x")).toBe(299);
  });
});

describe("youtubeTitle", () => {
  it("uses the first non-empty line, trimmed", () => {
    expect(youtubeTitle("\n\n  My video  \nDescription here")).toBe("My video");
  });
  it("caps the title at 100 characters", () => {
    expect(youtubeTitle("x".repeat(150))).toHaveLength(100);
  });
  it("falls back when empty", () => {
    expect(youtubeTitle("   ")).toBe("Untitled");
  });
});
