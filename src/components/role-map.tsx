import {
	EVERYONE_REACHES,
	ROLE_ACCESS,
	ROLES_BY_ACCESS,
	type Role,
} from "#/lib/roles";

/**
 * Which role reaches what in Sofia: one row per role, from most access to
 * least. `current` marks this device's row (null: guest); leave it out on
 * pages about no single device.
 */
export function RoleMap({ current }: { current?: Role | null }) {
	const mine = current === undefined ? undefined : (current ?? "guest");
	return (
		<figure className="flex flex-col gap-3 rounded-md border p-4">
			<figcaption className="text-sm font-medium">
				What each role reaches
			</figcaption>
			<p
				className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
				data-testid="role-everyone"
			>
				<span>Every device:</span>
				{EVERYONE_REACHES.map((place) => (
					<span key={place} className="rounded-full border px-2 py-0.5">
						{place}
					</span>
				))}
			</p>
			<ul className="flex flex-col gap-1.5">
				{ROLES_BY_ACCESS.map((role) => {
					const places = ROLE_ACCESS[role];
					const here = role === mine;
					return (
						<li
							key={role}
							data-testid="role-row"
							data-role={role}
							aria-current={here ? "true" : undefined}
							className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-sm ${here ? "bg-muted" : ""}`}
						>
							<span
								className={`w-24 shrink-0 whitespace-nowrap rounded-md border px-2 py-0.5 text-center font-mono text-xs ${here ? "border-foreground font-semibold" : ""}`}
							>
								{role}
							</span>
							<svg
								aria-hidden="true"
								viewBox="0 0 24 8"
								className="h-2 w-6 shrink-0 text-muted-foreground"
							>
								<path d="M0 4h20" stroke="currentColor" strokeWidth="1.25" />
								<path d="M18 1l4 3-4 3z" fill="currentColor" />
							</svg>
							<span className="flex flex-wrap gap-1.5">
								{places.length === 0 ? (
									<span className="text-xs text-muted-foreground">
										nothing in Sofia
									</span>
								) : (
									places.map((place) => (
										<span
											key={place}
											className="rounded-full bg-primary/10 px-2 py-0.5 text-xs"
										>
											{place}
										</span>
									))
								)}
							</span>
							{here ? (
								<span className="ml-auto shrink-0 text-xs text-muted-foreground">
									this device
								</span>
							) : null}
						</li>
					);
				})}
			</ul>
		</figure>
	);
}
