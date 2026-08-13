const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Expo resolves npm-workspace monorepos automatically. 101 packages export
// TypeScript source so games and Link share one protocol implementation.
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, "ts", "tsx", "mts"])];

module.exports = config;
