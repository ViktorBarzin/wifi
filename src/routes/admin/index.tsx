import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { CLIENT_ID_HEADER, clientId } from "@viktorbarzin/realtime/client";
import { useRealtimeInvalidation } from "@viktorbarzin/realtime/react";

import { app } from "#/app.config";
import { deviceKeys } from "#/lib/query-keys";
import { isRole, ROLES, type Role } from "#/lib/roles";
import { getAccessStatus, getAdminOverview } from "#/server/access.functions";
import { listDevices, setDeviceRole } from "#/server/wifi.functions";

/**
 * Every device the router has seen, with a role select per row. Admins
 * only: the admin check runs inside getAdminOverview and the device
 * functions; a non-admin sees the "admins only" error.
 */
export const Route = createFileRoute("/admin/")({
	loader: async ({ context }) => {
		const status = await getAccessStatus({ data: { returnTo: "/admin" } });
		if (!status.signedIn)
			throw redirect({ href: status.signInUrl, reloadDocument: true });
		const overview = await getAdminOverview();
		await context.queryClient.ensureQueryData({
			queryKey: deviceKeys.all,
			queryFn: () => listDevices(),
		});
		return { status, overview };
	},
	component: AdminPage,
	errorComponent: ({ error }) => (
		<main className="mx-auto max-w-xl p-6">
			<h1 className="mb-3 text-2xl font-semibold">Admin</h1>
			<p role="alert">
				{error instanceof Error ? error.message : String(error)}
			</p>
		</main>
	),
});

/** `2026-11-22 15:49 UTC`: the same on the server and in the browser, so hydration matches. */
function formatSeen(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function AdminPage() {
	const { status, overview } = Route.useLoaderData();
	const queryClient = useQueryClient();
	useRealtimeInvalidation({ queryClient, enabled: status.realtime });
	const devices = useQuery({
		queryKey: deviceKeys.all,
		queryFn: () => listDevices(),
		refetchInterval: status.realtime ? false : app.pollMs,
	});
	const set = useMutation({
		mutationFn: (change: { mac: string; role: Role | null }) =>
			setDeviceRole({
				data: change,
				headers: { [CLIENT_ID_HEADER]: clientId() },
			}),
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: deviceKeys.all }),
	});

	return (
		<main
			className="mx-auto flex max-w-2xl flex-col gap-4 p-4 sm:p-6"
			data-testid="admin-home"
		>
			<h1 className="text-2xl font-semibold">All devices</h1>
			<p className="text-sm text-muted-foreground">
				Signed in to {app.displayName} as {overview.username}. A device with no
				role is a guest.
			</p>
			{set.isError ? (
				<p role="alert" className="text-sm text-destructive">
					Could not change the role: {set.error.message}
				</p>
			) : null}
			{devices.isPending ? (
				<p className="text-muted-foreground">Loading...</p>
			) : devices.isError ? (
				<p role="alert">Could not load the devices.</p>
			) : (
				<div data-testid="devices">
					<table className="w-full text-left text-sm">
						<thead className="text-muted-foreground">
							<tr>
								<th className="p-2 font-medium">Device</th>
								<th className="p-2 font-medium">Role</th>
							</tr>
						</thead>
						<tbody>
							{devices.data.map((device) => (
								<tr
									key={device.mac}
									className="border-t align-top"
									data-testid="device-row"
									data-mac={device.mac}
								>
									<td className="p-2">
										<div className="font-medium break-words">
											{device.hostname ?? "Unnamed device"}
										</div>
										<div className="font-mono text-xs">{device.mac}</div>
										<div className="text-xs text-muted-foreground">
											{device.ip}, last seen {formatSeen(device.lastSeen)}
										</div>
									</td>
									<td className="p-2">
										<select
											aria-label={`Role of ${device.mac}`}
											className="h-9 rounded-md border bg-background px-2"
											value={device.role ?? "guest"}
											disabled={set.isPending}
											onChange={(event) => {
												const value = event.target.value;
												set.mutate({
													mac: device.mac,
													role: isRole(value) ? value : null,
												});
											}}
										>
											<option value="guest">guest</option>
											{ROLES.map((role) => (
												<option key={role} value={role}>
													{role}
												</option>
											))}
										</select>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{status.cloud ? null : (
				<a className="underline" href="/admin/requests">
					Access requests ({overview.pendingRequests ?? 0})
				</a>
			)}
			<a className="text-sm underline" href="/">
				Back to {app.displayName}
			</a>
		</main>
	);
}
