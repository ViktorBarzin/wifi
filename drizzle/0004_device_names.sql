CREATE TABLE "device_names" (
	"mac" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"fixed_ip" text,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_names_name_idx" ON "device_names" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "device_names_fixed_ip_idx" ON "device_names" USING btree ("fixed_ip");