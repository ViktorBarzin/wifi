/**
 * The built server over HTTP (`bun run build` first) with a real Postgres
 * (TEST_DATABASE_URL) and the mock Authentik from @viktorbarzin/auth/testing:
 * health and metrics ports, the auth wall, CSRF, the sign-in flow, request +
 * approve, the guest retry, the router API, the device page and a prompt
 * exit on SIGTERM. The full approval
 * through the admin page runs in e2e/auth.spec.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	type BuiltServer,
	CookieJar,
	follow,
	type MockAuthentik,
	startBuiltServer,
	startMockAuthentik,
} from "@viktorbarzin/auth/testing";
import { migratedTestDatabase } from "@viktorbarzin/pg/testing";

import { app } from "#/app.config";
import { sha256Hex } from "./wifi.server";

const APP_DIR = resolve(import.meta.dir, "../..");
const ENTRY = resolve(APP_DIR, ".output/server/index.mjs");
const adminUrl = process.env.TEST_DATABASE_URL;
const ready = Boolean(adminUrl) && existsSync(ENTRY);

let database: Awaited<ReturnType<typeof migratedTestDatabase>>;
let mock: MockAuthentik;
let server: BuiltServer;

const ROUTER_TOKEN = "router-token-0123456789abcdef0123456789";
const ROUTER = { authorization: `Bearer ${ROUTER_TOKEN}` };
const POLL_MS = 1_500;

beforeAll(async () => {
	if (!ready) return;
	database = await migratedTestDatabase({
		adminUrl: adminUrl as string,
		migrationsFolder: resolve(APP_DIR, "drizzle"),
		lockKey: app.migrationLockKey,
		prefix: "http_test",
	});
	mock = await startMockAuthentik({
		clientId: app.slug,
		usersGroup: app.usersGroup,
	});
	mock.addUser({ username: "guest", email: null, groups: ["Public Guests"] });
	server = await startBuiltServer({
		entry: ENTRY,
		cwd: APP_DIR,
		env: {
			DATABASE_URL: database.url,
			OIDC_DISCOVERY_URL: mock.discoveryUrl,
			OIDC_CLIENT_ID: mock.clientId,
			OIDC_CLIENT_SECRET: mock.clientSecret,
			BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
			AUTHENTIK_API_URL: mock.apiUrl,
			AUTHENTIK_READER_TOKEN: mock.readerToken,
			AUTHENTIK_APPROVER_TOKEN: mock.approverToken,
			ROUTER_TOKEN,
			ROUTER_POLL_TIMEOUT_MS: String(POLL_MS),
		},
		origin: (port) => ({ PUBLIC_ORIGINS: `http://127.0.0.1:${port}` }),
	});
}, 60_000);

afterAll(async () => {
	if (!ready) return;
	await server?.stop();
	await mock?.stop();
	await database?.drop();
});

async function signIn(username: string, path = "/api/auth/start?return=%2F") {
	mock.session = null;
	mock.loginAs = username;
	const jar = new CookieJar();
	const result = await follow(`${server.origin}${path}`, jar, server.origin);
	return { jar, ...result };
}

function get(
	path: string,
	jar: CookieJar | null,
	headers: Record<string, string> = {},
) {
	return fetch(`${server.origin}${path}`, {
		redirect: "manual",
		headers: { ...(jar ? { cookie: jar.header() } : {}), ...headers },
	});
}

/** The href of the page's sign-in link, or null when there is none. */
function signInHref(html: string): string | null {
	return (
		/<a\b[^>]*\bhref="([^"]*)"[^>]*>Sign in to use your role on this device<\/a>/.exec(
			html,
		)?.[1] ?? null
	);
}

function putLeases(body: string, headers: Record<string, string> = ROUTER) {
	return fetch(`${server.origin}/api/router/leases`, {
		method: "PUT",
		headers: { "content-type": "text/plain", ...headers },
		body,
	});
}

function pollRoles(
	since: number,
	leases: string,
	headers: Record<string, string> = ROUTER,
) {
	return get(
		`/api/router/roles?since=${since}&leases=${leases}`,
		null,
		headers,
	);
}

/** The events stream, which needs a signed-in member. */
function events(jar: CookieJar | null, headers: Record<string, string> = {}) {
	return get("/api/events", jar, {
		"sec-fetch-site": "same-origin",
		...headers,
	});
}

describe.skipIf(!ready)("the built server", () => {
	test("/healthz answers ok", async () => {
		const res = await get("/healthz", null);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	test("/favicon.ico answers with an icon, signed in or not (round 7)", async () => {
		const res = await get("/favicon.ico", null);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type") ?? "").toContain("icon");
		expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});

	test("/metrics is served on METRICS_PORT only", async () => {
		await get("/healthz", null);
		const metrics = await fetch(`${server.metricsOrigin}/metrics`);
		expect(metrics.status).toBe(200);
		const text = await metrics.text();
		expect(text).toContain("process_cpu_user_seconds_total");
		expect(text).toMatch(
			/^http_requests_total\{method="GET",handler="\/healthz",status="2xx"\} [1-9]/m,
		);
		const publicRes = await get("/metrics", null);
		expect(publicRes.status).toBe(404);
		expect(await publicRes.text()).not.toContain(
			"process_cpu_user_seconds_total",
		);
	});

	test("the LISTEN connection opens at boot", async () => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const rows = await database.client`
				select pid from pg_stat_activity
				where datname = current_database() and query ilike ${`listen%${app.realtimeChannel}%`}`;
			const text = await (
				await fetch(`${server.metricsOrigin}/metrics`)
			).text();
			if (rows.length === 1 && /^realtime_listen_connected 1$/m.test(text))
				break;
			if (Date.now() > deadline) throw new Error("no LISTEN at boot");
			await Bun.sleep(100);
		}
	});

	test("/api/events is 401 without a session, and a forged forward-auth header changes nothing", async () => {
		for (const headers of [{}, { "x-authentik-username": "admin" }] as Record<
			string,
			string
		>[]) {
			const res = await events(null, headers);
			expect(res.status).toBe(401);
			expect((await res.json()).error.code).toBe("unauthorized");
		}
	});

	test("the router API is 401 with no body for a missing or wrong token", async () => {
		for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<
			string,
			string
		>[]) {
			const poll = await pollRoles(0, "0".repeat(64), headers);
			expect(poll.status).toBe(401);
			expect(await poll.text()).toBe("");
			const put = await putLeases(
				"aa:00:00:00:01:01 192.168.8.70 x\n",
				headers,
			);
			expect(put.status).toBe(401);
			expect(await put.text()).toBe("");
		}
	});

	test("lease PUT: 204 and stored; a bad line is 400; the poll says whether it needs the table", async () => {
		const table =
			"aa:00:00:00:01:01 192.168.8.70 laptop\naa:00:00:00:01:02 192.168.8.71 *\n";
		const put = await putLeases(table);
		expect(put.status).toBe(204);
		const rows =
			await database.client`select mac, ip, hostname from devices where mac like 'aa:00:00:00:01:%' order by mac`;
		expect(rows).toEqual([
			{ mac: "aa:00:00:00:01:01", ip: "192.168.8.70", hostname: "laptop" },
			{ mac: "aa:00:00:00:01:02", ip: "192.168.8.71", hostname: null },
		]);
		const bad = await putLeases("aa:00:00:00:01:03 192.168.8.72 x\nnonsense\n");
		expect(bad.status).toBe(400);
		expect(await bad.text()).toContain("line 2");

		const [{ roles_version: version }] =
			await database.client`select roles_version from sync_state`;
		const started = Date.now();
		const same = await pollRoles(
			Number(version),
			sha256Hex(new TextEncoder().encode(table)),
		);
		expect(same.status).toBe(200);
		expect(same.headers.get("content-type")).toContain("text/plain");
		expect(await same.text()).toBe(`unchanged ${version}\nleases ok\n`);
		expect(Date.now() - started).toBeGreaterThanOrEqual(POLL_MS - 100);
		const other = await pollRoles(Number(version), "f".repeat(64));
		expect(await other.text()).toBe(`unchanged ${version}\nleases needed\n`);
		const [{ last_router_poll: polled }] =
			await database.client`select last_router_poll from sync_state`;
		expect(Date.now() - polled.getTime()).toBeLessThan(10_000);
	});

	test("the poll answers at once with the full list when the router is behind", async () => {
		const res = await pollRoles(999_999, "0".repeat(64));
		const [{ roles_version: version }] =
			await database.client`select roles_version from sync_state`;
		expect((await res.text()).split("\n").slice(0, 2)).toEqual([
			`version ${version}`,
			"leases needed",
		]);
	});

	test("a malformed poll query is 400", async () => {
		for (const query of [
			`since=x&leases=${"0".repeat(64)}`,
			"since=1&leases=abc",
			"since=1",
		]) {
			const res = await get(`/api/router/roles?${query}`, null, ROUTER);
			expect(res.status).toBe(400);
		}
	});

	test("/metrics has the router's last poll time and the role change counter", async () => {
		await pollRoles(999_999, "0".repeat(64));
		const text = await (await fetch(`${server.metricsOrigin}/metrics`)).text();
		const seconds = Number(
			/^wifi_router_last_poll_timestamp_seconds (\S+)$/m.exec(text)?.[1],
		);
		expect(Math.abs(Date.now() / 1000 - seconds)).toBeLessThan(30);
		expect(text).toMatch(/^wifi_role_changes_total \d+$/m);
	});

	test("the home page shows a signed-out visitor a sign-in link, with 200", async () => {
		const res = await get("/", null);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(app.displayName);
		expect(signInHref(html)).toBe("/api/auth/start?return=%2F");
		expect(html).not.toContain('data-testid="username"');
	});

	test("the home page finds this device by X-Real-IP, and explains when it cannot", async () => {
		await putLeases("aa:00:00:00:02:01 192.168.8.80 tv\n");
		await database.client`insert into device_roles (mac, role, set_by) values ('aa:00:00:00:02:01', 'iot', 'test')`;
		const html = await (
			await get("/", null, { "x-real-ip": "192.168.8.80" })
		).text();
		expect(html).toContain("aa:00:00:00:02:01");
		expect(html).toMatch(/data-testid="device-role"[^>]*>iot</);
		const away = await (
			await get("/", null, { "x-real-ip": "10.9.9.9" })
		).text();
		expect(away).toContain('data-testid="device-unknown"');
		expect(away).toContain("London Wi-Fi");
	});

	test("pages and redirects refuse to be framed", async () => {
		for (const path of [
			"/pending",
			"/healthz",
			"/api/router/roles",
			"/api/auth/finish?return=/",
		]) {
			const res = await get(path, null);
			expect(res.headers.get("content-security-policy")).toBe(
				"frame-ancestors 'none'",
			);
			expect(res.headers.get("x-frame-options")).toBe("DENY");
		}
	});

	test("a cross-origin POST is refused before it reaches a handler", async () => {
		for (const path of ["/_serverFn/anything", "/api/router/leases"]) {
			const res = await fetch(`${server.origin}${path}`, {
				method: "PUT",
				headers: {
					origin: "https://evil.example",
					cookie: `__Host-${app.slug}.session_token=x`,
				},
			});
			expect(res.status).toBe(403);
			expect((await res.json()).error.code).toBe("forbidden");
		}
	});

	test("a member signs in and gets a __Host- session cookie", async () => {
		mock.addUser({ username: "member@example.com", groups: [app.usersGroup] });
		const { jar, hops, response } = await signIn("member@example.com");
		expect(hops.at(-1)?.url).toBe(`${server.origin}/`);
		expect(response.status).toBe(200);
		const session = jar.raw.find((c) =>
			c.startsWith(`__Host-${app.slug}.session_token=`),
		);
		expect(session?.toLowerCase()).toContain("httponly");
		expect(session?.toLowerCase()).not.toContain("domain=");
		expect(await response.text()).toContain("member@example.com");
		const stream = await events(jar);
		expect(stream.status).toBe(200);
		await stream.body?.cancel();
	});

	test("a non-member gets 403 access_pending and an access request; approval lets them in", async () => {
		const user = mock.addUser({ username: "stranger@example.com", groups: [] });
		const { jar, hops } = await signIn("stranger@example.com");
		expect(hops.at(-1)?.url).toBe(`${server.origin}/`);
		const res = await events(jar);
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe("access_pending");
		const rows =
			await database.client`select status from access_requests where sub = ${user.uid}`;
		expect(rows).toEqual([{ status: "pending" }]);

		// An admin approves (here at the provider; e2e/auth.spec.ts goes through
		// the admin page). The next re-check lets the person in.
		user.groups.push(app.usersGroup);
		await database.client`update member_checks set checked_at = now() - interval '16 minutes' where sub = ${user.uid}`;
		const stream = await events(jar);
		expect(stream.status).toBe(200);
		await stream.body?.cancel();
	});

	test("the admin page is for the admins group: every device, and a link to access requests", async () => {
		await putLeases("aa:00:00:00:03:01 192.168.8.90 printer\n");
		mock.addUser({ username: "chief@example.com", groups: [app.adminsGroup] });
		const admin = await signIn(
			"chief@example.com",
			"/api/auth/start?return=%2Fadmin",
		);
		expect(admin.hops.at(-1)?.url).toBe(`${server.origin}/admin`);
		const html = await admin.response.text();
		expect(html).toContain('data-testid="admin-home"');
		expect(html).toContain('data-mac="aa:00:00:00:03:01"');
		expect(html).toContain('href="/admin/requests"');
		mock.addUser({ username: "worker@example.com", groups: [app.usersGroup] });
		const member = await signIn(
			"worker@example.com",
			"/api/auth/start?return=%2Fadmin",
		);
		const refused = await member.response.text();
		expect(refused).toContain("admins only");
		expect(refused).not.toContain('data-testid="admin-home"');
		expect(refused).not.toContain("aa:00:00:00:03:01");
	});

	test("bearer tokens work for /api/events, and a bad one does not fall back to the cookie", async () => {
		const user = mock.addUser({
			username: "cli@example.com",
			groups: [app.usersGroup],
		});
		const token = await mock.mintAccessToken({
			sub: user.uid,
			preferred_username: user.username,
			groups: user.groups,
		});
		const ok = await events(null, { authorization: `Bearer ${token}` });
		expect(ok.status).toBe(200);
		await ok.body?.cancel();
		const { jar } = await signIn("cli@example.com");
		expect(
			(await events(jar, { authorization: "Bearer not-a-jwt" })).status,
		).toBe(401);
	});

	test("the anonymous guest gets prompt=login once", async () => {
		mock.addUser({ username: "real@example.com", groups: [app.usersGroup] });
		mock.session = "guest";
		mock.loginAs = "real@example.com";
		mock.authorizations.length = 0;
		const jar = new CookieJar();
		const { hops } = await follow(
			`${server.origin}/api/auth/start?return=%2F`,
			jar,
			server.origin,
		);
		expect(mock.authorizations.map((a) => [a.prompt, a.user])).toEqual([
			[null, "guest"],
			["login", "real@example.com"],
		]);
		expect(hops.at(-1)?.url).toBe(`${server.origin}/`);
	});

	test("every log line is JSON", async () => {
		await fetch(`${server.origin}/_serverFn/garbage`, {
			method: "POST",
			headers: { origin: server.origin, "content-type": "application/json" },
			body: "{}",
		});
		await Bun.sleep(200);
		const notJson = server.logs.filter((line) => {
			try {
				const record = JSON.parse(line) as Record<string, unknown>;
				return !(
					record.timestamp &&
					record.severity_text &&
					record["logger.name"] &&
					"body" in record
				);
			} catch {
				return true;
			}
		});
		expect(notJson).toEqual([]);
	});

	test("SIGTERM exits 0 within the drain window, even with an SSE stream open", async () => {
		mock.addUser({
			username: "streamer@example.com",
			groups: [app.usersGroup],
		});
		const { jar } = await signIn("streamer@example.com");
		const controller = new AbortController();
		const events = await fetch(`${server.origin}/api/events`, {
			signal: controller.signal,
			headers: {
				cookie: jar.header(),
				accept: "text/event-stream",
				"sec-fetch-site": "same-origin",
			},
		});
		expect(events.status).toBe(200);
		await events.body?.getReader().read();
		const started = Date.now();
		server.kill("SIGTERM");
		const code = await Promise.race([
			server.exited,
			Bun.sleep(8_000).then(() => "still running"),
		]);
		expect(code).toBe(0);
		expect(Date.now() - started).toBeLessThan(6_000);
		controller.abort();
	}, 15_000);
});
