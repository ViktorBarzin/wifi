import { createFileRoute } from "@tanstack/react-router";

import { pool } from "#/server/db.server";
import { routerToken } from "#/server/env.server";
import { plainText } from "#/server/router.server";
import { routerAuthorized } from "#/server/router-auth.server";
import { storeLeases } from "#/server/wifi.server";

/** A home lease table is a few kilobytes; refuse anything far bigger. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * PUT /api/router/leases: the router's dnsmasq lease table, one
 * `<mac> <ip> <hostname-or-*>` per line (text/plain, ROUTER_TOKEN bearer).
 * 204 when stored, 400 naming the first malformed line.
 */
export const Route = createFileRoute("/api/router/leases")({
	server: {
		handlers: {
			PUT: async ({ request }) => {
				if (!routerAuthorized(request, routerToken()))
					return plainText(401, null);
				if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
					return plainText(413, "lease table too large\n");
				const raw = new Uint8Array(await request.arrayBuffer());
				if (raw.byteLength > MAX_BODY_BYTES)
					return plainText(413, "lease table too large\n");
				const result = await storeLeases(pool.getDb(), raw);
				if (!result.ok)
					return plainText(400, `line ${result.line}: ${result.reason}\n`);
				return new Response(null, { status: 204 });
			},
		},
	},
});
