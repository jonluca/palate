DROP INDEX "user_confirmed_visit_user_start_idx";--> statement-breakpoint
DROP INDEX "user_confirmed_visit_restaurant_user_start_idx";--> statement-breakpoint
CREATE INDEX "canonical_restaurant_name_location_idx" ON "canonical_restaurant" USING btree ("name","location");--> statement-breakpoint
CREATE INDEX "canonical_restaurant_award_year_name_idx" ON "canonical_restaurant" USING btree ("award","latest_award_year" DESC NULLS LAST,"name");--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_user_start_created_idx" ON "user_confirmed_visit" USING btree ("user_id","start_time" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_confirmed_visit_restaurant_user_start_created_idx" ON "user_confirmed_visit" USING btree ("restaurant_id","user_id","start_time" DESC NULLS LAST,"created_at" DESC NULLS LAST);