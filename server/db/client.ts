import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseSchema } from "./schema";
import { serverEnv } from "../env";

const queryClient = postgres(serverEnv.databaseUrl, {
  prepare: false,
  max: 10,
});

export const db = drizzle(queryClient, {
  schema: databaseSchema,
});

export async function closeDatabaseConnection() {
  await queryClient.end({ timeout: 5 });
}
