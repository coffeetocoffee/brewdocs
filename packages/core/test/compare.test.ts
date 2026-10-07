import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { safeEqual } from "@brewdocs/core";

describe("v4.6 constant-time credential comparison (finding #20)", () => {
  it("is true exactly when the strings are equal", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "a")).toBe(false);
    // Same length, differs in the last byte — the case a byte loop exists for.
    const a = "a".repeat(63) + "1";
    const b = "a".repeat(63) + "2";
    expect(safeEqual(a, b)).toBe(false);
    expect(safeEqual(a, a)).toBe(true);
  });

  it("never throws on a length mismatch", () => {
    // The whole reason for the wrapper: crypto.timingSafeEqual throws
    // RangeError here, and in the server that throw used to exit the process.
    expect(() => crypto.timingSafeEqual(Buffer.from("ab"), Buffer.from("abcd"))).toThrow(
      RangeError,
    );
    expect(() => safeEqual("ab", "abcd")).not.toThrow();
    expect(safeEqual("ab", "abcd")).toBe(false);
    expect(safeEqual("bd_live_short", "bd_live_a_much_longer_key")).toBe(false);
  });

  it("compares UTF-8 bytes, so it keeps `===` semantics for non-ASCII", () => {
    expect(safeEqual("café", "café")).toBe(true);
    expect(safeEqual("café", "cafe")).toBe(false);
    // Same text, different Unicode normalization: `===` says false, and so must
    // we — safeEqual must not be *more* permissive than the comparison it
    // replaced, or a caller could authenticate with a re-encoded secret.
    const composed: string = "\u00e9";
    const decomposed: string = "e\u0301";
    expect(safeEqual(composed, decomposed)).toBe(false);
    expect(composed === decomposed).toBe(false);
  });

  it("answers false (not a throw) for non-strings", () => {
    // A hand-edited store can hold a number or null where a hash belongs.
    expect(safeEqual(undefined as unknown as string, "x")).toBe(false);
    expect(safeEqual("x", null as unknown as string)).toBe(false);
    expect(safeEqual(42 as unknown as string, "42")).toBe(false);
  });
});
