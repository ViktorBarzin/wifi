import { describe, expect, test } from "bun:test";

import { isRole, mayAssignOwn, ROLES, roleOf } from "./roles";

const admin = { member: true, admin: true };
const storage = { member: true, admin: false };
const stranger = { member: false, admin: false };

describe("roles", () => {
	test("the six roles; guest is no role", () => {
		expect([...ROLES]).toEqual([
			"admin",
			"storage",
			"iot",
			"infra-ha",
			"infra-k8s",
			"media",
		]);
		expect(isRole("iot")).toBe(true);
		expect(isRole("guest")).toBe(false);
	});

	test("an admin's role is admin, a member's is storage, anyone else has none", () => {
		expect(roleOf(admin)).toBe("admin");
		expect(roleOf(storage)).toBe("storage");
		expect(roleOf(stranger)).toBeNull();
	});

	test("on their own device a person may set only their own role or guest", () => {
		expect(mayAssignOwn(storage, "storage")).toBe(true);
		expect(mayAssignOwn(storage, null)).toBe(true);
		expect(mayAssignOwn(storage, "admin")).toBe(false);
		expect(mayAssignOwn(storage, "iot")).toBe(false);
		expect(mayAssignOwn(admin, "admin")).toBe(true);
		expect(mayAssignOwn(admin, null)).toBe(true);
		expect(mayAssignOwn(admin, "storage")).toBe(false);
		expect(mayAssignOwn(stranger, null)).toBe(false);
	});
});
