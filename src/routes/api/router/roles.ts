import { createFileRoute } from "@tanstack/react-router";

import { pool } from "#/server/db.server";
import { routerPollTimeoutMs, routerToken } from "#/server/env.server";
import { plainText, pollRoles } from "#/server/router.server";
import { routerAuthorized } from "#/server/router-auth.server";

const SINCE = /^\d{1,15}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * GET /api/router/roles?since=<version>&leases=<sha256 hex>: the London
 * router's long poll (text/plain, ROUTER_TOKEN bearer). Held up to
 * ROUTER_POLL_TIMEOUT_MS (50 s); every request may idle 255 s (start.ts).
 */
export const Route = createFileRoute("/api/router/roles")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!routerAuthorized(request, routerToken()))
					return plainText(401, null);
				const query = new URL(request.url).searchParams;
				const since = query.get("since") ?? "";
				const leases = query.get("leases") ?? "";
				if (!SINCE.test(since) || !SHA256_HEX.test(leases))
					return plainText(400, "want ?since=<int>&leases=<sha256 hex>\n");
				const body = await pollRoles(pool.getDb(), {
					since: Number(since),
					leases,
					timeoutMs: routerPollTimeoutMs(),
					signal: request.signal,
				});
				return plainText(200, body);
			},
		},
	},
});
