/**
 * The London router's long poll. The router sends the role-list version it
 * holds; the answer comes at once when the version differs, else when a
 * role write's NOTIFY arrives on the app's one LISTEN connection, else
 * "unchanged" at the timeout. Nothing polls the database in a loop: the wait
 * reads the version once, then again only after each realtime event.
 */

import type { Db, Tx } from "./db.server";
import { realtime } from "./realtime.server";
import {
	listRoles,
	listRouterEntries,
	markRouterPoll,
	readSyncState,
	type SyncState,
} from "./wifi.server";

/** The realtime topic of held router polls; role writes publish to every topic. */
const ROUTER_TOPIC = "wifi:router";

/** A text/plain answer for the router. `null` body: no detail (the 401). */
export function plainText(status: number, body: string | null): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/** The event types of an SSE stream, one per frame that names one. */
async function* sseEventTypes(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		buffer += decoder.decode(value, { stream: true });
		for (
			let end = buffer.indexOf("\n\n");
			end >= 0;
			end = buffer.indexOf("\n\n")
		) {
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const type = /^event: ?(.+)$/m.exec(frame)?.[1];
			if (type) yield type;
		}
	}
}

function whenAborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/**
 * The sync state once its version differs from `since`, or at `timeoutMs`,
 * or when `signal` aborts (the router hung up) or the stream closes (the
 * pod is shutting down), whichever comes first.
 */
export async function waitForRoles(
	db: Db | Tx,
	since: number,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<SyncState> {
	const stop = new AbortController();
	const abort = () => stop.abort();
	const timer = setTimeout(abort, timeoutMs);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	// Subscribe before the first read, so a write between the read and the
	// wait still wakes us. The stream closes when `stop` aborts.
	const stream = realtime.subscribe(
		new Request("http://wifi.invalid/router-poll", { signal: stop.signal }),
		ROUTER_TOPIC,
	).body;
	const reader = stream?.getReader() ?? null;
	try {
		// The first poll after boot may come before LISTEN is up.
		await Promise.race([
			realtime.start().catch(() => {}),
			whenAborted(stop.signal),
		]);
		let state = await readSyncState(db);
		if (reader === null) return state;
		const events = sseEventTypes(reader);
		// Any event (a role write, or a resync after LISTEN reconnected) means
		// "read the version again".
		while (state.rolesVersion === since && !stop.signal.aborted) {
			if ((await events.next()).done) break;
			state = await readSyncState(db);
		}
		return state;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		stop.abort();
		await reader?.cancel().catch(() => {});
	}
}

export interface PollOptions {
	/** The role-list version the router holds. */
	since: number;
	/** SHA-256 hex of the router's lease table. */
	leases: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** 1: `<mac> <role>` for devices with a role. 2: `<mac> <role|guest> <name|-> <fixed ip|->` for devices with a role or a name. */
	format?: 1 | 2;
}

/**
 * The poll's text/plain body: `version <N>` and the full list (see
 * PollOptions.format), or
 * `unchanged <N>`; then `leases needed` or `leases ok`. Every line ends in
 * `\n`, so busybox `read` sees the last one.
 */
export async function pollRoles(
	db: Db | Tx,
	opts: PollOptions,
): Promise<string> {
	await markRouterPoll(db);
	const state = await waitForRoles(db, opts.since, opts.timeoutMs, opts.signal);
	const changed = state.rolesVersion !== opts.since;
	const lines = [
		`${changed ? "version" : "unchanged"} ${state.rolesVersion}`,
		opts.leases.toLowerCase() === state.leasesHash
			? "leases ok"
			: "leases needed",
	];
	if (changed && opts.format === 2)
		for (const e of await listRouterEntries(db))
			lines.push(
				`${e.mac} ${e.role ?? "guest"} ${e.name ?? "-"} ${e.fixedIp ?? "-"}`,
			);
	else if (changed)
		for (const { mac, role } of await listRoles(db))
			lines.push(`${mac} ${role}`);
	return lines.map((line) => `${line}\n`).join("");
}
