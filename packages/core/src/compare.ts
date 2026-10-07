import * as crypto from "node:crypto";

/**
 * Constant-time string comparison for credentials.
 *
 * A plain `===` on secrets is not guaranteed constant-time, so each byte
 * compared leaks a little timing signal (finding #20). The canonical fix is
 * `crypto.timingSafeEqual`, which this wraps for two reasons:
 *
 *  1. It **never throws**. `timingSafeEqual` throws a RangeError when the
 *     buffers differ in length. In this server a throw inside the async
 *     request handler used to exit the process (finding #21), so a naive swap
 *     would have traded a theoretical timing leak for an unauthenticated
 *     crash: any token of the wrong length. Returning false is the correct
 *     answer (401) and cannot crash.
 *
 *  2. It compares **UTF-8 bytes of the strings**, so `safeEqual(a, b)` is true
 *     exactly when `a === b`. Hashing both sides to a fixed-width digest first
 *     also removes the length question, but it would make
 *     `safeEqual(hashOfKey, storedHash)` true — hashing would have to be part
 *     of the caller's contract, and a caller that forgot would silently
 *     compare digests instead of secrets. Byte comparison keeps `===`
 *     semantics and puts the one difference (length mismatch → false) where
 *     callers can reason about it.
 *
 * Timing caveat, stated rather than implied: an early return on unequal
 * *length* leaks the length of the secret. That is fine for the credentials
 * here (fixed-width hex hashes and `bd_live_…` keys), and it is the same
 * trade the Node docs make for `timingSafeEqual` itself.
 *
 * @param a - first string (typically the presented credential).
 * @param b - second string (typically the stored credential).
 * @returns true when the strings are byte-identical.
 */
export function safeEqual(a: string, b: string): boolean {
  // Total by construction: a hand-edited store (or any non-string reaching
  // here despite the types) must answer "no", not throw.
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
