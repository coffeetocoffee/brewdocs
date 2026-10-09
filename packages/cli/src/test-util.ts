import type * as http from "node:http";

/**
 * v4.7 finding #30: every test server must bind loopback. A bare
 * `server.listen(0)` binds `::` — every interface — which is exactly the INV-1
 * hazard the production `serve` command fixed by passing "127.0.0.1". Nine
 * test call sites had reintroduced it, so while `npm test` ran on a shared or
 * untrusted network, the unauthenticated build API (an `npm install` of a
 * caller-supplied name) was reachable from the LAN. The shared helper makes
 * the correct call the only call; scripts/gate.mjs refuses a bare
 * `listen(<number>)` in any *.test.ts.
 *
 * @param server - the server to start.
 * @param port - the port to bind (0 = ephemeral).
 * @returns the bound port.
 */
export function listenLocal(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}
