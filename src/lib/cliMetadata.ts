import { readFileSync } from "node:fs";

interface PackageManifest {
  version?: unknown;
}

/**
 * Read the package version relative to the compiled/source CLI entrypoint.
 * `src/lib` and `dist/lib` are both exactly two levels below package.json,
 * so the same URL works under tsx and from an installed package.
 */
function loadPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("agent-trellis package.json does not declare a version");
  }
  return manifest.version;
}

export const TRELLIS_VERSION = loadPackageVersion();
