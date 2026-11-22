import { expect, test } from "@playwright/test";

import { app } from "../src/app.config";
import {
	addDevice,
	addUser,
	call,
	collectErrors,
	pageFrom,
	signedInPage,
} from "./fixtures";

test("a signed-out visitor sees this device and a sign-in link", async ({
	browser,
}) => {
	await addDevice("aa:00:00:00:10:01", "192.168.8.101", "visitor-phone");
	const page = await pageFrom(browser, "192.168.8.101");
	const errors = collectErrors(page);
	await addUser("newcomer@example.com", [app.usersGroup]);
	await call("/login-as", { username: "newcomer@example.com" });
	const home = await page.goto("/");
	expect(home?.status()).toBe(200);
	await expect(
		page.getByRole("heading", { name: app.displayName }),
	).toBeVisible();
	await expect(page.getByTestId("this-device")).toContainText("visitor-phone");
	await expect(page.getByTestId("device-role")).toHaveText("guest");
	await expect(
		page.locator('[data-testid="role-row"][aria-current="true"]'),
	).toHaveAttribute("data-role", "guest");
	const signIn = page.getByRole("link", {
		name: "Sign in to use your role on this device",
	});
	await expect(signIn).toHaveAttribute("href", "/api/auth/start?return=%2F");
	await signIn.click();
	await expect(page.getByTestId("username")).toHaveText("newcomer@example.com");
	expect(errors).toEqual([]);
});

test("a member gives the device they are on their role, then makes it a guest", async ({
	browser,
}) => {
	await addDevice("aa:00:00:00:10:02", "192.168.8.102", "anca-macbook");
	await addUser("member@example.com", [app.usersGroup]);
	const page = await signedInPage(
		browser,
		"member@example.com",
		"/",
		"192.168.8.102",
	);
	const errors = collectErrors(page);
	await expect(page.getByTestId("username")).toHaveText("member@example.com");
	await expect(page.getByTestId("device-role")).toHaveText("guest");
	await page
		.getByRole("button", { name: "Give this device my role (storage)" })
		.click();
	await expect(page.getByTestId("device-role")).toHaveText("storage");
	await page.getByRole("button", { name: "Make this device a guest" }).click();
	await expect(page.getByTestId("device-role")).toHaveText("guest");
	expect(errors).toEqual([]);
});

test("off the London Wi-Fi the page says so and offers no buttons", async ({
	browser,
}) => {
	await addUser("away@example.com", [app.usersGroup]);
	const page = await signedInPage(browser, "away@example.com", "/", "10.9.9.9");
	await expect(page.getByTestId("device-unknown")).toContainText(
		"not on the London Wi-Fi",
	);
	await expect(page.getByRole("button")).toHaveCount(0);
});

test("the header keeps the title and a long email apart on a phone", async ({
	browser,
}) => {
	const email = "a-long-family-member-name@example.com";
	await addUser(email, [app.usersGroup]);
	const page = await signedInPage(browser, email);
	await page.setViewportSize({ width: 390, height: 800 });
	const user = page.getByTestId("username");
	await expect(user).toHaveText(email);
	const title = await page
		.getByRole("heading", { name: app.displayName })
		.boundingBox();
	const name = await user.boundingBox();
	if (!title || !name) throw new Error("header not laid out");
	// Side by side with a gap, or the email on a line of its own below.
	const apart =
		name.x >= title.x + title.width + 8 || name.y >= title.y + title.height;
	expect(apart).toBe(true);
	expect(name.x + name.width).toBeLessThanOrEqual(390);
});

test("a non-member asks for access and waits on /pending until an admin approves", async ({
	browser,
}) => {
	await addUser("asker@example.com", []);
	const asker = await signedInPage(browser, "asker@example.com");
	await asker.getByRole("link", { name: "Ask for access" }).click();
	await expect(asker).toHaveURL(/\/pending$/);
	await expect(asker.getByTestId("access-pending")).toContainText(
		"asker@example.com",
	);

	await addUser("boss@example.com", [app.adminsGroup]);
	const boss = await signedInPage(
		browser,
		"boss@example.com",
		"/admin/requests",
	);
	const request = boss
		.getByTestId("access-request")
		.filter({ hasText: "asker@example.com" });
	await expect(request).toBeVisible();
	await request.getByRole("button", { name: "Approve" }).click();
	await expect(
		boss.getByTestId("access-request").filter({ hasText: "asker@example.com" }),
	).toHaveCount(0);

	await asker.getByRole("button", { name: "Check again" }).click();
	await expect(asker.getByTestId("access-granted")).toBeVisible();
	await asker.getByRole("link", { name: `Open ${app.displayName}` }).click();
	await expect(asker.getByTestId("username")).toHaveText("asker@example.com");
	await expect(asker.getByRole("link", { name: "Ask for access" })).toHaveCount(
		0,
	);
});

test("the admin pages refuse a member who is not an admin", async ({
	browser,
}) => {
	await addUser("plain@example.com", [app.usersGroup]);
	for (const path of ["/admin/requests", "/admin"]) {
		const page = await signedInPage(browser, "plain@example.com", path);
		await expect(page.getByRole("alert")).toContainText("admins only");
		await expect(page.getByTestId("device-row")).toHaveCount(0);
	}
});

test("an admin sets any device's role from the device table", async ({
	browser,
}) => {
	await addDevice("aa:00:00:00:10:03", "192.168.8.103", "ha-london");
	await addUser("viktor@example.com", [app.adminsGroup]);
	const page = await signedInPage(browser, "viktor@example.com", "/admin");
	const errors = collectErrors(page);
	const select = page.getByLabel("Role of aa:00:00:00:10:03");
	await expect(select).toHaveValue("guest");
	await select.selectOption("infra-ha");
	await expect(select).toHaveValue("infra-ha");
	await page.reload();
	await expect(page.getByLabel("Role of aa:00:00:00:10:03")).toHaveValue(
		"infra-ha",
	);
	await page.getByLabel("Role of aa:00:00:00:10:03").selectOption("guest");
	await page.reload();
	await expect(page.getByLabel("Role of aa:00:00:00:10:03")).toHaveValue(
		"guest",
	);
	expect(errors).toEqual([]);
});

test("an admin names a device, fixes its address, and sees a clash refused", async ({
	browser,
}) => {
	await addDevice("aa:00:00:00:10:07", "192.168.8.107", "Watch");
	await addDevice("aa:00:00:00:10:08", "192.168.8.108", "*");
	await addUser("namer@example.com", [app.adminsGroup]);
	const page = await signedInPage(browser, "namer@example.com", "/admin");
	const errors = collectErrors(page);
	const row = page.locator('[data-mac="aa:00:00:00:10:07"]');
	await page.getByLabel("Name of aa:00:00:00:10:07").fill("watch-viktor");
	await page
		.getByLabel("Fixed address of aa:00:00:00:10:07")
		.fill("192.168.8.107");
	await row.getByRole("button", { name: "Save" }).click();
	await expect(row).toContainText("calls itself Watch");
	await page.reload();
	await expect(page.getByLabel("Name of aa:00:00:00:10:07")).toHaveValue(
		"watch-viktor",
	);
	await expect(
		page.getByLabel("Fixed address of aa:00:00:00:10:07"),
	).toHaveValue("192.168.8.107");

	const other = page.locator('[data-mac="aa:00:00:00:10:08"]');
	await page.getByLabel("Name of aa:00:00:00:10:08").fill("watch-viktor");
	await other.getByRole("button", { name: "Save" }).click();
	await expect(other.getByRole("alert")).toContainText("another device's name");
	expect(errors.filter((e) => !e.includes("409"))).toEqual([]);
});
