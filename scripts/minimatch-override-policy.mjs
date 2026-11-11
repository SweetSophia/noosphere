// This is a deliberately out-of-range lint-only edge, qualified on Node22/24
// with the consumer matcher API, full lint/typecheck and production build.
// A parent range or pin change requires re-qualification, not a silent override.
export const qualifiedMinimatchVersion = "11.0.8";
export function minimatchOverrideFailures(manifest, lock) {
  const failures = [];
  if (manifest.overrides?.["@typescript-eslint/typescript-estree"]?.minimatch !== qualifiedMinimatchVersion) {
    failures.push("TypeScript-ESLint minimatch pin changed; re-qualify the forced edge.");
  }
  if (lock.packages?.["node_modules/@typescript-eslint/typescript-estree"]?.dependencies?.minimatch !== "^10.2.2") {
    failures.push("TypeScript-ESLint's declared minimatch range changed; re-qualify the forced edge.");
  }
  if (lock.packages?.["node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch"]?.version !== qualifiedMinimatchVersion) {
    failures.push("TypeScript-ESLint must resolve the qualified patched minimatch version.");
  }
  return failures;
}
