/**
 * The app's own Prometheus metrics, prefix `wifi_`, on the process registry
 * that /metrics serves. One set per process (processSingleton): the Nitro
 * boot plugin and the routes are two module graphs.
 */
import { getRegistry } from "@viktorbarzin/metrics";
import { processSingleton } from "@viktorbarzin/runtime";
import { eq } from "drizzle-orm";
import client from "prom-client";
import { syncState } from "./db/schema.server";
import { pool } from "./db.server";

async function lastRouterPoll(): Promise<Date | null> {
	const [row] = await pool
		.getDb()
		.select({ at: syncState.lastRouterPoll })
		.from(syncState)
		.where(eq(syncState.id, 1));
	return row?.at ?? null;
}

export function wifiMetrics() {
	return processSingleton("wifi.metrics", () => {
		const registers = [getRegistry()];
		return {
			roleChanges: new client.Counter({
				name: "wifi_role_changes_total",
				help: "Role writes that changed a device's role (set, changed or cleared).",
				registers,
			}),
			lastPoll: new client.Gauge({
				name: "wifi_router_last_poll_timestamp_seconds",
				help: "Unix time of the London router's last role poll (sync_state.last_router_poll); 0 before the first.",
				registers,
				async collect() {
					// A failed read keeps the last value; the scrape still answers.
					const at = await lastRouterPoll().catch(() => undefined);
					if (at) this.set(at.getTime() / 1000);
				},
			}),
		};
	});
}
