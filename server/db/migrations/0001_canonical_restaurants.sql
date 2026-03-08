CREATE TABLE "canonical_restaurant" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'michelin' NOT NULL,
	"source_restaurant_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"cuisine" text DEFAULT '' NOT NULL,
	"phone_number" text,
	"website_url" text,
	"source_url" text,
	"latest_award_year" integer,
	"award" text DEFAULT '' NOT NULL,
	"has_green_star" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_restaurant_source_source_id_idx" ON "canonical_restaurant" USING btree ("source","source_restaurant_id");--> statement-breakpoint
CREATE INDEX "canonical_restaurant_name_idx" ON "canonical_restaurant" USING btree ("name");--> statement-breakpoint
CREATE INDEX "canonical_restaurant_location_idx" ON "canonical_restaurant" USING btree ("location");--> statement-breakpoint
CREATE INDEX "canonical_restaurant_lat_lon_idx" ON "canonical_restaurant" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_restaurant_user_start_idx" ON "user_confirmed_visit" USING btree ("restaurant_id","user_id","start_time");