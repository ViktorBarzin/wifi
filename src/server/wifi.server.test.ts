/**
 * The wifi domain against a real Postgres (TEST_DATABASE_URL), migrated with
 * the app's own migrations: leases, roles, the router's long poll and the
 * own-device rule. The long poll waits on the app's realtime LISTEN
 * connection, so this file points DATABASE_URL at its test database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migratedTestDatabase } from "@viktorbarzin/pg/testing";
import { drizzle } from "drizzle-orm/bun-sql";

import { app } from "#/app.config";
import * as schema from "./db/schema.server";
import { pool } from "./db.server";
import { realtime } from "./realtime.server";
import { pollRoles } from "./router.server";
import {
	assignOwnDevice,
	clientIp,
	findDeviceByIp,
	listDevices,
	parseLeases,
	readSyncState,
	setRole,
	sha256Hex,
	storeLeases,
} from "./wifi.server";

const adminUrl = process.env.TEST_DATABASE_URL;
let database: Awaited<ReturnType<typeof migratedTestDatabase>>;
const runtimeEnv: Record<string, string | undefined> = process.env;
const previousUrl = runtimeEnv.DATABASE_URL;

beforeAll(async () => {
	if (!adminUrl) return;
	database = await migratedTestDatabase({
		adminUrl,
		migrationsFolder: resolve(import.meta.dir, "../../drizzle"),
		lockKey: app.migrationLockKey,
		prefix: "wifi_test",
	});
	runtimeEnv.DATABASE_URL = database.url;
	await realtime.start();
});

afterAll(async () => {
	if (!adminUrl) return;
	await realtime.stop();
	await pool.close();
	runtimeEnv.DATABASE_URL = previousUrl;
	await database.drop();
});

function db() {
	return drizzle({ client: database.client, schema });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("clientIp", () => {
	test("is X-Real-IP when it holds an address, else null", () => {
		const req = (headers: Record<string, string>) =>
			new Request("http://wifi.invalid/", { headers });
		expect(clientIp(req({ "x-real-ip": "192.168.8.10" }))).toBe("192.168.8.10");
		expect(clientIp(req({ "X-Real-Ip": " 192.168.8.11 " }))).toBe(
			"192.168.8.11",
		);
		expect(clientIp(req({ "x-real-ip": "fd00::1" }))).toBe("fd00::1");
		expect(clientIp(req({ "x-real-ip": "not-an-ip" }))).toBeNull();
		expect(clientIp(req({ "x-forwarded-for": "192.168.8.10" }))).toBeNull();
	});
});

describe("parseLeases", () => {
	test("reads mac, ip and hostname; * is no hostname; MACs become lowercase", () => {
		expect(
			parseLeases(
				"AA:BB:CC:00:11:22 192.168.8.10 mbp-london\n0e:5b:07:32:7e:7d 192.168.8.11 *\n",
			),
		).toEqual({
			ok: true,
			leases: [
				{
					mac: "aa:bb:cc:00:11:22",
					ip: "192.168.8.10",
					hostname: "mbp-london",
				},
				{ mac: "0e:5b:07:32:7e:7d", ip: "192.168.8.11", hostname: null },
			],
		});
		expect(parseLeases("")).toEqual({ ok: true, leases: [] });
	});

	test("a malformed line is refused with its line number", () => {
		for (const [body, line] of [
			["aa:bb:cc:00:11:22 192.168.8.10\n", 1],
			["aa:bb:cc:00:11:22 192.168.8.10 a extra\n", 1],
			["aa:bb:cc:00:11:22 192.168.8.10 ok\nnot-a-mac 192.168.8.11 x\n", 2],
			["aa:bb:cc:00:11:22 999.1.1.1 x\n", 1],
			["aa-bb-cc-00-11-22 192.168.8.10 x\n", 1],
		] as const) {
			const result = parseLeases(body);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.line).toBe(line);
		}
	});
});

describe.skipIf(!adminUrl)("wifi with a database", () => {
	test("storeLeases upserts devices, keeps absent ones and stores the body's hash", async () => {
		const first =
			"aa:00:00:00:00:01 192.168.8.21 phone\naa:00:00:00:00:02 192.168.8.22 *\n";
		expect(await storeLeases(db(), bytes(first))).toEqual({
			ok: true,
			count: 2,
		});
		const before =
			await database.client`select mac, first_seen, last_seen from devices where mac = 'aa:00:00:00:00:01'`;
		await Bun.sleep(20);
		const second = "aa:00:00:00:00:01 192.168.8.31 phone-renamed\n";
		expect(await storeLeases(db(), bytes(second))).toEqual({
			ok: true,
			count: 1,
		});

		const rows = await database.client`
			select mac, ip, hostname, first_seen, last_seen from devices
			where mac like 'aa:00:00:00:00:0%' order by mac`;
		expect(
			rows.map((r: { mac: string; ip: string; hostname: string | null }) => [
				r.mac,
				r.ip,
				r.hostname,
			]),
		).toEqual([
			["aa:00:00:00:00:01", "192.168.8.31", "phone-renamed"],
			["aa:00:00:00:00:02", "192.168.8.22", null],
		]);
		expect(rows[0].first_seen).toEqual(before[0].first_seen);
		expect(rows[0].last_seen.getTime()).toBeGreaterThan(
			before[0].last_seen.getTime(),
		);
		expect((await readSyncState(db())).leasesHash).toBe(
			sha256Hex(bytes(second)),
		);
	});

	test("a malformed body changes nothing", async () => {
		const hash = (await readSyncState(db())).leasesHash;
		const result = await storeLeases(
			db(),
			bytes("aa:00:00:00:00:09 192.168.8.40 x\nbroken\n"),
		);
		expect(result).toEqual({ ok: false, line: 2, reason: expect.any(String) });
		expect((await readSyncState(db())).leasesHash).toBe(hash);
		expect(
			await database.client`select 1 from devices where mac = 'aa:00:00:00:00:09'`,
		).toEqual([]);
	});

	test("every role write bumps the version and notifies, a no-op does not", async () => {
		const start = (await readSyncState(db())).rolesVersion;
		const set = await setRole(db(), {
			mac: "aa:00:00:00:00:01",
			role: "storage",
			setBy: "sub-1",
			source: null,
		});
		expect(set).toEqual({ changed: true, version: start + 1 });
		const update = await setRole(db(), {
			mac: "aa:00:00:00:00:01",
			role: "iot",
			setBy: "sub-2",
			source: null,
		});
		expect(update.version).toBe(start + 2);
		const rows =
			await database.client`select role, set_by from device_roles where mac = 'aa:00:00:00:00:01'`;
		expect(rows).toEqual([{ role: "iot", set_by: "sub-2" }]);
		const cleared = await setRole(db(), {
			mac: "aa:00:00:00:00:01",
			role: null,
			setBy: "sub-2",
			source: null,
		});
		expect(cleared.version).toBe(start + 3);
		const again = await setRole(db(), {
			mac: "aa:00:00:00:00:01",
			role: null,
			setBy: "sub-2",
			source: null,
		});
		expect(again).toEqual({ changed: false, version: start + 3 });
	});

	test("the long poll answers at once when the version is newer, with the sorted list", async () => {
		await setRole(db(), {
			mac: "aa:00:00:00:00:02",
			role: "infra-ha",
			setBy: "s",
			source: null,
		});
		await setRole(db(), {
			mac: "aa:00:00:00:00:01",
			role: "admin",
			setBy: "s",
			source: null,
		});
		const state = await readSyncState(db());
		const started = Date.now();
		const body = await pollRoles(db(), {
			since: state.rolesVersion - 1,
			leases: state.leasesHash,
			timeoutMs: 5_000,
		});
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(body).toBe(
			`version ${state.rolesVersion}\nleases ok\naa:00:00:00:00:01 admin\naa:00:00:00:00:02 infra-ha\n`,
		);
	});

	test("the long poll answers unchanged after its timeout, and asks for leases when the hash differs", async () => {
		const state = await readSyncState(db());
		const started = Date.now();
		const body = await pollRoles(db(), {
			since: state.rolesVersion,
			leases: "0".repeat(64),
			timeoutMs: 400,
		});
		expect(Date.now() - started).toBeGreaterThanOrEqual(390);
		expect(body).toBe(`unchanged ${state.rolesVersion}\nleases needed\n`);
		const polled = await readSyncState(db());
		expect(polled.lastRouterPoll?.getTime()).toBeGreaterThanOrEqual(
			started - 1_000,
		);
	});

	test("the long poll wakes on the NOTIFY of a role write, well before its timeout", async () => {
		const state = await readSyncState(db());
		const started = Date.now();
		const poll = pollRoles(db(), {
			since: state.rolesVersion,
			leases: state.leasesHash,
			timeoutMs: 10_000,
		});
		await Bun.sleep(300);
		await setRole(db(), {
			mac: "aa:00:00:00:00:02",
			role: "infra-k8s",
			setBy: "s",
			source: null,
		});
		const body = await poll;
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(body.split("\n").slice(0, 2)).toEqual([
			`version ${state.rolesVersion + 1}`,
			"leases ok",
		]);
		expect(body).toContain("aa:00:00:00:00:02 infra-k8s\n");
	});

	test("an aborted poll ends early", async () => {
		const state = await readSyncState(db());
		const controller = new AbortController();
		const started = Date.now();
		const poll = pollRoles(db(), {
			since: state.rolesVersion,
			leases: state.leasesHash,
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		await Bun.sleep(200);
		controller.abort();
		expect(await poll).toStartWith(`unchanged ${state.rolesVersion}\n`);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("a device is found by its address, the most recently seen first, with its role", async () => {
		await storeLeases(db(), bytes("aa:00:00:00:00:03 192.168.8.50 old\n"));
		await Bun.sleep(20);
		await storeLeases(db(), bytes("aa:00:00:00:00:04 192.168.8.50 new\n"));
		await setRole(db(), {
			mac: "aa:00:00:00:00:04",
			role: "iot",
			setBy: "s",
			source: null,
		});
		expect(await findDeviceByIp(db(), "192.168.8.50")).toEqual({
			mac: "aa:00:00:00:00:04",
			ip: "192.168.8.50",
			hostname: "new",
			role: "iot",
			lastSeen: expect.any(String),
		});
		expect(await findDeviceByIp(db(), "192.168.8.99")).toBeNull();
		const all = await listDevices(db());
		expect(all.find((d) => d.mac === "aa:00:00:00:00:03")?.role).toBeNull();
	});

	test("a member may give their own device their role or guest, never admin", async () => {
		await storeLeases(db(), bytes("aa:00:00:00:00:05 192.168.8.60 macbook\n"));
		const member = {
			sub: "anca",
			username: "anca",
			member: true,
			admin: false,
		};
		await assignOwnDevice(db(), member, "192.168.8.60", "storage", null);
		expect((await findDeviceByIp(db(), "192.168.8.60"))?.role).toBe("storage");
		await expect(
			assignOwnDevice(db(), member, "192.168.8.60", "admin", null),
		).rejects.toMatchObject({ status: 403 });
		expect((await findDeviceByIp(db(), "192.168.8.60"))?.role).toBe("storage");
		await assignOwnDevice(db(), member, "192.168.8.60", null, null);
		expect((await findDeviceByIp(db(), "192.168.8.60"))?.role).toBeNull();
		await expect(
			assignOwnDevice(db(), member, "10.9.9.9", "storage", null),
		).rejects.toMatchObject({ status: 404 });
		await expect(
			assignOwnDevice(db(), member, null, "storage", null),
		).rejects.toMatchObject({ status: 404 });
		const stranger = { sub: "x", username: "x", member: false, admin: false };
		await expect(
			assignOwnDevice(db(), stranger, "192.168.8.60", null, null),
		).rejects.toMatchObject({ status: 403 });
	});
});
