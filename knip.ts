import type { KnipConfig } from "knip";

const config = async (): Promise<KnipConfig> => {
  return {
    entry: ["app/**/*.tsx", "app/*.tsx"],
    project: ["**/*.{js,ts,tsx,mjs,cjs,mts,cts}"],
    metro: {
      entry: ["**/*.{ios,android,web,native}.{ts,tsx,js,json}"],
    },
    expo: true,
    ignore: ["babel.config.js", "app.config.ts", "metro.config.js"],
    ignoreBinaries: ["eas"],
    ignoreDependencies: ["@buoy-gg/react-query", "@buoy-gg/highlight-updates", "@buoy-gg/core"],
  } satisfies KnipConfig;
};

export default config;
