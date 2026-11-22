import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

import { ROLES } from "#/lib/roles";
import { RoleMap } from "./role-map";

describe("RoleMap", () => {
	test("shows a row for every role and for guest, with what each reaches", () => {
		render(<RoleMap current={null} />);
		const rows = screen.getAllByTestId("role-row");
		expect(rows.map((row) => row.dataset.role)).toEqual([
			"admin",
			"infra-k8s",
			"infra-ha",
			"media",
			"storage",
			"iot",
			"guest",
		]);
		expect(new Set(rows.map((row) => row.dataset.role))).toEqual(
			new Set([...ROLES, "guest"]),
		);
		const admin = rows[0] as HTMLElement;
		expect(within(admin).getByText("all of Sofia")).toBeInTheDocument();
		const guest = rows[6] as HTMLElement;
		expect(within(guest).getByText("nothing in Sofia")).toBeInTheDocument();
		expect(screen.getByTestId("role-everyone")).toHaveTextContent(
			"the internet",
		);
	});

	test("marks the role of this device", () => {
		render(<RoleMap current="storage" />);
		const marked = screen
			.getAllByTestId("role-row")
			.filter((row) => row.getAttribute("aria-current") === "true");
		expect(marked.map((row) => row.dataset.role)).toEqual(["storage"]);
	});

	test("a device with no role is marked as guest", () => {
		render(<RoleMap current={null} />);
		const marked = screen
			.getAllByTestId("role-row")
			.filter((row) => row.getAttribute("aria-current") === "true");
		expect(marked.map((row) => row.dataset.role)).toEqual(["guest"]);
	});
});
