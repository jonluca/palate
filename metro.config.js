// Learn more https://docs.expo.io/guides/customizing-metro
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const { withUniwindConfig } = require("uniwind/metro");
const path = require("path");

const projectRoot = __dirname;

/** @type {import('expo/metro-config').MetroConfig} */
const config = getSentryExpoConfig(__dirname);

config.resolver.nodeModulesPaths = [...config.resolver.nodeModulesPaths, path.join(projectRoot, "node_modules")];

// Add CSV and DB to asset extensions for Michelin data
config.resolver.assetExts = [...config.resolver.assetExts, "csv", "db"];

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./globals.css",
  extraThemes: ["sepia", "bubblegum"],
});
