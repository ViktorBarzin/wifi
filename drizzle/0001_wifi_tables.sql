CREATE TYPE "public"."device_role" AS ENUM('admin', 'storage', 'iot', 'infra-ha', 'infra-k8s');--> statement-breakpoint
CREATE TABLE "device_roles" (
	"mac" text PRIMARY KEY NOT NULL,
	"role" "device_role" NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"mac" text PRIMARY KEY NOT NULL,
	"ip" text NOT NULL,
	"hostname" text,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"roles_version" bigint DEFAULT 0 NOT NULL,
	"leases_hash" text DEFAULT '' NOT NULL,
	"last_router_poll" timestamp with time zone,
	CONSTRAINT "sync_state_one_row" CHECK ("sync_state"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX "devices_ip_idx" ON "devices" USING btree ("ip","last_seen");