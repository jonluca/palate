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
ALTER TABLE "user_confirmed_visit_comment" ADD CONSTRAINT "user_confirmed_visit_comment_visit_user_id_user_id_fk" FOREIGN KEY ("visit_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_comment" ADD CONSTRAINT "user_confirmed_visit_comment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_comment" ADD CONSTRAINT "user_confirmed_visit_comment_visit_fk" FOREIGN KEY ("visit_user_id","visit_local_visit_id") REFERENCES "public"."user_confirmed_visit"("user_id","local_visit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_like" ADD CONSTRAINT "user_confirmed_visit_like_visit_user_id_user_id_fk" FOREIGN KEY ("visit_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_like" ADD CONSTRAINT "user_confirmed_visit_like_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_confirmed_visit_like" ADD CONSTRAINT "user_confirmed_visit_like_visit_fk" FOREIGN KEY ("visit_user_id","visit_local_visit_id") REFERENCES "public"."user_confirmed_visit"("user_id","local_visit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_comment_author_idx" ON "user_confirmed_visit_comment" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_comment_visit_idx" ON "user_confirmed_visit_comment" USING btree ("visit_user_id","visit_local_visit_id","created_at");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_like_user_idx" ON "user_confirmed_visit_like" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_like_visit_idx" ON "user_confirmed_visit_like" USING btree ("visit_user_id","visit_local_visit_id");