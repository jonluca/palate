import "dotenv/config";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseOrigins(value: string | undefined) {
  return (
    value
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? []
  );
}

const port = Number(process.env.PORT ?? 3001);

export const serverEnv = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port,
  databaseUrl: requireEnv("DATABASE_URL"),
  betterAuthSecret: requireEnv("BETTER_AUTH_SECRET"),
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? `http://127.0.0.1:${port}`,
  trustedOrigins: parseOrigins(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
};
