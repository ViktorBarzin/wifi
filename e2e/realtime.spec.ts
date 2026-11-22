import { expect, test } from "@playwright/test";

import { app } from "../src/app.config";
import { addDevice, addUser, call, signedInPage } from "./fixtures";

test("a role set in one admin tab shows in another within 2 s, without a reload", async ({
	browser,
}) => {
	await addDevice("aa:00:00:00:20:01", "192.168.8.121", "plug-1");
	await addUser("twotabs@example.com", [app.adminsGroup]);
	const a = await signedInPage(browser, "twotabs@example.com", "/admin");
	const b = await signedInPage(browser, "twotabs@example.com", "/admin");
	const inA = a.getByLabel("Role of aa:00:00:00:20:01");
	const inB = b.getByLabel("Role of aa:00:00:00:20:01");
	await expect(inA).toHaveValue("guest");
	await expect(inB).toHaveValue("guest");
	// Let B's EventSource open before the write.
	await b.waitForTimeout(500);
	let reloaded = false;
	b.on("framenavigated", () => {
		reloaded = true;
	});

	await inA.selectOption("iot");
	await expect(inB).toHaveValue("iot", { timeout: 2_000 });
	expect(reloaded).toBe(false);
});

test("after the LISTEN connection is killed, the other tab resyncs", async ({
	browser,
}) => {
	await addDevice("aa:00:00:00:20:02", "192.168.8.122", "plug-2");
	await addUser("resync@example.com", [app.adminsGroup]);
	const b = await signedInPage(browser, "resync@example.com", "/admin");
	const select = b.getByLabel("Role of aa:00:00:00:20:02");
	await expect(select).toHaveValue("guest");
	await b.waitForTimeout(500);

	// A write that sends no NOTIFY: only a resync can bring it to the page.
	await call("/silent-role", { mac: "aa:00:00:00:20:02", role: "iot" });
	await b.waitForTimeout(500);
	await expect(select).toHaveValue("guest");

	await call("/kill-listen");
	await expect(select).toHaveValue("iot", { timeout: 15_000 });
});
