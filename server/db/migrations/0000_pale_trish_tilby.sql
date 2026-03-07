CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "user_confirmed_visit_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"visit_user_id" text NOT NULL,
	"visit_local_visit_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_confirmed_visit_like" (
	"visit_user_id" text NOT NULL,
	"visit_local_visit_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_confirmed_visit_like_pk" PRIMARY KEY("visit_user_id","visit_local_visit_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_follow" (
	"follower_id" text NOT NULL,
	"followee_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_follow_pk" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
CREATE TABLE "user_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"bio" text,
	"home_city" text,
	"favorite_cuisine" text,
	"public_visits" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit" ADD CONSTRAINT "user_confirmed_visit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_comment" ADD CONSTRAINT "user_confirmed_visit_comment_visit_user_id_user_id_fk" FOREIGN KEY ("visit_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_comment" ADD CONSTRAINT "user_confirmed_visit_comment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_comment" ADD CONSTRAINT "user_confirmed_visit_comment_visit_fk" FOREIGN KEY ("visit_user_id","visit_local_visit_id") REFERENCES "public"."user_confirmed_visit"("user_id","local_visit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_like" ADD CONSTRAINT "user_confirmed_visit_like_visit_user_id_user_id_fk" FOREIGN KEY ("visit_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_like" ADD CONSTRAINT "user_confirmed_visit_like_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_like" ADD CONSTRAINT "user_confirmed_visit_like_visit_fk" FOREIGN KEY ("visit_user_id","visit_local_visit_id") REFERENCES "public"."user_confirmed_visit"("user_id","local_visit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follow" ADD CONSTRAINT "user_follow_follower_id_user_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follow" ADD CONSTRAINT "user_follow_followee_id_user_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_user_start_idx" ON "user_confirmed_visit" USING btree ("user_id","start_time");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_comment_author_idx" ON "user_confirmed_visit_comment" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_comment_visit_idx" ON "user_confirmed_visit_comment" USING btree ("visit_user_id","visit_local_visit_id","created_at");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_like_user_idx" ON "user_confirmed_visit_like" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_like_visit_idx" ON "user_confirmed_visit_like" USING btree ("visit_user_id","visit_local_visit_id");--> statement-breakpoint
CREATE INDEX "user_follow_followee_idx" ON "user_follow" USING btree ("followee_id");--> statement-breakpoint
CREATE INDEX "user_follow_follower_idx" ON "user_follow" USING btree ("follower_id");