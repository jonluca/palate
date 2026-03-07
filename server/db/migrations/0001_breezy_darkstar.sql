CREATE TABLE "user_confirmed_visit" (
	"user_id" text NOT NULL,
	"local_visit_id" text NOT NULL,
	"restaurant_id" text,
	"restaurant_name" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"center_lat" double precision NOT NULL,
	"center_lon" double precision NOT NULL,
	"photo_count" integer DEFAULT 0 NOT NULL,
	"award_at_visit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_confirmed_visit_pk" PRIMARY KEY("user_id","local_visit_id")
);
--> statement-breakpoint
CREATE TABLE "user_follow" (
	"follower_id" text NOT NULL,
	"followee_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_follow_pk" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "public_visits" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit" ADD CONSTRAINT "user_confirmed_visit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follow" ADD CONSTRAINT "user_follow_follower_id_user_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follow" ADD CONSTRAINT "user_follow_followee_id_user_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_user_start_idx" ON "user_confirmed_visit" USING btree ("user_id","start_time");--> statement-breakpoint
CREATE INDEX "user_follow_followee_idx" ON "user_follow" USING btree ("followee_id");--> statement-breakpoint
CREATE INDEX "user_follow_follower_idx" ON "user_follow" USING btree ("follower_id");