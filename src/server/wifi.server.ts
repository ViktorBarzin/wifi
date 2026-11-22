/**
 * The London Wi-Fi domain: the router's lease table, device roles and the
 * single sync_state row. Every role write bumps `roles_version` and sends a
 * NOTIFY on the app's realtime channel (`wifi_roles`) in its own
 * transaction, so the router's held poll wakes at COMMIT and a rolled-back
 * write wakes no one.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ApiError } from "@viktorbarzin/runtime";
import { desc, eq, sql } from "drizzle-orm";

import { deviceKeys } from "#/lib/query-keys";
import { mayAssignOwn, type Role, type Who } from "#/lib/roles";
import { deviceRoles, devices, syncState } from "./db/schema.server";
import type { Db, Tx } from "./db.server";
import { wifiMetrics } from "./metrics.server";
import { realtime } from "./realtime.server";

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const HOSTNAME = /^[!-~]{1,253}$/;

/** `aa:bb:cc:00:11:22` from any case, or null when it is not a colon-form MAC. */
export function normalizeMac(raw: string): string | null {
	const mac = raw.toLowerCase();
	return MAC.test(mac) ? mac : null;
}

/** The client address the London proxy (or Traefik) puts in X-Real-IP; null when absent or not an IP. */
export function clientIp(request: Request): string | null {
	const value = request.headers.get("x-real-ip")?.trim() ?? "";
	return isIP(value) ? value : null;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export interface Lease {
	mac: string;
	ip: string;
	hostname: string | null;
}

export type ParsedLeases =
	| { ok: true; leases: Lease[] }
	| { ok: false; line: number; reason: string };

/** Lines of `<mac> <ip> <hostname-or-*>`; empty lines are skipped. */
export function parseLeases(text: string): ParsedLeases {
	const leases: Lease[] = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line === "") continue;
		const fail = (reason: string): ParsedLeases => ({
			ok: false,
			line: index + 1,
			reason,
		});
		const parts = line.split(" ");
		if (parts.length !== 3) return fail("want <mac> <ip> <hostname-or-*>");
		const [rawMac = "", ip = "", hostname = ""] = parts;
		const mac = normalizeMac(rawMac);
		if (mac === null) return fail("bad mac");
		if (isIP(ip) === 0) return fail("bad ip");
		if (hostname !== "*" && !HOSTNAME.test(hostname))
			return fail("bad hostname");
		leases.push({ mac, ip, hostname: hostname === "*" ? null : hostname });
	}
	return { ok: true, leases };
}

export interface SyncState {
	rolesVersion: number;
	leasesHash: string;
	lastRouterPoll: Date | null;
}

export async function readSyncState(db: Db | Tx): Promise<SyncState> {
	const [row] = await db
		.select({
			rolesVersion: syncState.rolesVersion,
			leasesHash: syncState.leasesHash,
			lastRouterPoll: syncState.lastRouterPoll,
		})
		.from(syncState)
		.where(eq(syncState.id, 1));
	if (!row) throw new Error("sync_state has no row; run the migrations");
	return row;
}

export async function markRouterPoll(db: Db | Tx): Promise<void> {
	await db
		.update(syncState)
		.set({ lastRouterPoll: sql`now()` })
		.where(eq(syncState.id, 1));
}

export type StoreLeasesResult =
	| { ok: true; count: number }
	| { ok: false; line: number; reason: string };

/**
 * Upsert the router's lease table and remember the SHA-256 of the exact body.
 * Devices missing from the table stay: they are offline, not gone.
 */
export async function storeLeases(
	db: Db | Tx,
	raw: Uint8Array,
): Promise<StoreLeasesResult> {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		return { ok: false, line: 0, reason: "body is not UTF-8" };
	}
	const parsed = parseLeases(text);
	if (!parsed.ok) return parsed;
	// One row per MAC; a repeated MAC keeps its last line.
	const unique = [...new Map(parsed.leases.map((l) => [l.mac, l])).values()];
	await db.transaction(async (tx) => {
		if (unique.length > 0)
			await tx
				.insert(devices)
				.values(unique)
				.onConflictDoUpdate({
					target: devices.mac,
					set: {
						ip: sql`excluded.ip`,
						hostname: sql`excluded.hostname`,
						lastSeen: sql`now()`,
					},
				});
		await tx
			.update(syncState)
			.set({ leasesHash: sha256Hex(raw) })
			.where(eq(syncState.id, 1));
	});
	return { ok: true, count: unique.length };
}

export interface RoleChange {
	mac: string;
	/** null: make the device a guest (delete its row). */
	role: Role | null;
	/** The acting person's OIDC `sub`. */
	setBy: string;
	/** The writing tab's client id, so that tab skips its own event. */
	source: string | null;
}

/** Set or clear a device's role. A change bumps the version and notifies in the same transaction. */
export async function setRole(
	db: Db | Tx,
	change: RoleChange,
): Promise<{ changed: boolean; version: number }> {
	const result = await db.transaction(async (tx) => {
		let changed: boolean;
		if (change.role === null) {
			const removed = await tx
				.delete(deviceRoles)
				.where(eq(deviceRoles.mac, change.mac))
				.returning({ mac: deviceRoles.mac });
			changed = removed.length > 0;
		} else {
			await tx
				.insert(deviceRoles)
				.values({ mac: change.mac, role: change.role, setBy: change.setBy })
				.onConflictDoUpdate({
					target: deviceRoles.mac,
					set: { role: change.role, setBy: change.setBy, setAt: sql`now()` },
				});
			changed = true;
		}
		if (!changed)
			return { changed, version: (await readSyncState(tx)).rolesVersion };
		const [row] = await tx
			.update(syncState)
			.set({ rolesVersion: sql`${syncState.rolesVersion} + 1` })
			.where(eq(syncState.id, 1))
			.returning({ version: syncState.rolesVersion });
		if (!row) throw new Error("sync_state has no row; run the migrations");
		await realtime.publishInTx(tx, null, {
			type: "invalidate",
			keys: [deviceKeys.all],
			source: change.source,
		});
		return { changed, version: row.version };
	});
	if (result.changed) wifiMetrics().roleChanges.inc();
	return result;
}

/** Every role, sorted by MAC (byte order, whatever the database collation). */
export async function listRoles(
	db: Db | Tx,
): Promise<{ mac: string; role: Role }[]> {
	const rows = await db
		.select({ mac: deviceRoles.mac, role: deviceRoles.role })
		.from(deviceRoles);
	return rows.sort((a, b) => (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0));
}

/** The wire shape: dates as ISO strings. */
export interface DeviceView {
	mac: string;
	ip: string;
	hostname: string | null;
	role: Role | null;
	lastSeen: string;
}

function deviceQuery(db: Db | Tx) {
	return db
		.select({
			mac: devices.mac,
			ip: devices.ip,
			hostname: devices.hostname,
			role: deviceRoles.role,
			lastSeen: devices.lastSeen,
		})
		.from(devices)
		.leftJoin(deviceRoles, eq(deviceRoles.mac, devices.mac));
}

function view(row: {
	mac: string;
	ip: string;
	hostname: string | null;
	role: Role | null;
	lastSeen: Date;
}): DeviceView {
	return { ...row, lastSeen: row.lastSeen.toISOString() };
}

/** The device that holds `ip` now: the most recently seen one with that address. */
export async function findDeviceByIp(
	db: Db | Tx,
	ip: string,
): Promise<DeviceView | null> {
	const [row] = await deviceQuery(db)
		.where(eq(devices.ip, ip))
		.orderBy(desc(devices.lastSeen))
		.limit(1);
	return row ? view(row) : null;
}

/** Every device, most recently seen first. */
export async function listDevices(db: Db | Tx): Promise<DeviceView[]> {
	const rows = await deviceQuery(db).orderBy(desc(devices.lastSeen));
	return rows.map(view);
}

/**
 * A signed-in person sets the role of the device they are on (found by its
 * address): their own role or guest, nothing else.
 */
export async function assignOwnDevice(
	db: Db | Tx,
	who: Who & { sub: string | null; username: string },
	ip: string | null,
	role: Role | null,
	source: string | null,
): Promise<void> {
	if (!mayAssignOwn(who, role))
		throw new ApiError(
			403,
			"forbidden",
			"you may give this device only your own role, or make it a guest",
		);
	const device = ip === null ? null : await findDeviceByIp(db, ip);
	if (!device)
		throw new ApiError(
			404,
			"not_found",
			"this device is not on the London Wi-Fi",
		);
	await setRole(db, {
		mac: device.mac,
		role,
		setBy: who.sub ?? who.username,
		source,
	});
}
