import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";

import { app } from "#/app.config";
import { Button } from "#/components/ui/button";
import { type Role, roleOf } from "#/lib/roles";
import { getAccessStatus, type PageAccess } from "#/server/access.functions";
import { getThisDevice, setThisDeviceRole } from "#/server/wifi.functions";

/**
 * "This device": the device the request comes from (by its address on the
 * London Wi-Fi) and its role. Anyone sees it; a signed-in person with a role
 * may give the device that role or make it a guest.
 */
export const Route = createFileRoute("/")({
	loader: async () => {
		const [status, here] = await Promise.all([
			getAccessStatus({ data: { returnTo: "/" } }),
			getThisDevice(),
		]);
		return { status, here };
	},
	component: Home,
});

function Home() {
	const { status, here } = Route.useLoaderData();
	const device = here.device;
	return (
		<main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 p-6">
			<header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h1 className="text-2xl font-semibold">{app.displayName}</h1>
				{status.signedIn ? (
					<span className="flex min-w-0 items-baseline gap-3 text-sm text-muted-foreground">
						<span className="break-all" data-testid="username">
							{status.username}
						</span>
						{status.signOutUrl ? (
							<a className="underline" href={status.signOutUrl}>
								Sign out
							</a>
						) : null}
					</span>
				) : null}
			</header>
			<h2 className="text-lg font-medium">This device</h2>
			{device ? (
				<dl
					className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-4"
					data-testid="this-device"
				>
					<dt className="text-muted-foreground">Name</dt>
					<dd className="break-all">{device.hostname ?? "Unnamed device"}</dd>
					<dt className="text-muted-foreground">MAC</dt>
					<dd className="font-mono">{device.mac}</dd>
					<dt className="text-muted-foreground">Role</dt>
					<dd data-testid="device-role">{device.role ?? "guest"}</dd>
				</dl>
			) : (
				<p data-testid="device-unknown">
					This device is not on the London Wi-Fi
					{here.ip ? ` (its address is ${here.ip})` : ""}. Open this page on a
					device connected to the London Wi-Fi.
				</p>
			)}
			{!status.signedIn ? (
				<a className="underline" href={status.signInUrl}>
					Sign in to use your role on this device
				</a>
			) : device ? (
				<RoleButtons status={status} current={device.role} />
			) : null}
			{status.signedIn && !status.member ? (
				<p className="text-sm text-muted-foreground">
					Your account has no Wi-Fi role.{" "}
					<a className="underline" href="/pending">
						Ask for access
					</a>
				</p>
			) : null}
			{status.admin ? (
				<a className="text-sm underline" href="/admin">
					All devices
				</a>
			) : null}
		</main>
	);
}

function RoleButtons({
	status,
	current,
}: {
	status: PageAccess;
	current: Role | null;
}) {
	const router = useRouter();
	const mine = roleOf(status);
	const set = useMutation({
		mutationFn: (role: Role | null) => setThisDeviceRole({ data: { role } }),
		onSuccess: () => router.invalidate(),
	});
	if (mine === null) return null;
	return (
		<div className="flex flex-col gap-2">
			<Button
				disabled={set.isPending || current === mine}
				onClick={() => set.mutate(mine)}
			>
				Give this device my role ({mine})
			</Button>
			<Button
				variant="outline"
				disabled={set.isPending || current === null}
				onClick={() => set.mutate(null)}
			>
				Make this device a guest
			</Button>
			{set.isError ? (
				<p role="alert" className="text-sm text-destructive">
					Could not change the role: {set.error.message}
				</p>
			) : null}
		</div>
	);
}
