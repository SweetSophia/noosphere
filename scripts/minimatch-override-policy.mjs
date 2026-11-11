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
  const nested = "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch";
  const resolved = lock.packages?.[nested]?.version;
  if (resolved !== qualifiedMinimatchVersion) {
    failures.push(`${nested}: found ${String(resolved)}; must resolve the qualified patched minimatch version ${qualifiedMinimatchVersion}.`);
  }
  // Closed qualification set: the inherited 3.1.5 copy is outside this
  // advisory, and 11.0.8 is the tested override. New copies require review.
  for (const [entry, metadata] of Object.entries(lock.packages ?? {})) {
    if (/(?:^|\/)node_modules\/minimatch$/.test(entry) &&
        !["3.1.5", qualifiedMinimatchVersion].includes(metadata.version)) {
      failures.push(`${entry}: found ${String(metadata.version)}; unqualified minimatch resolution requires re-qualification.`);
    }
  }
  return failures;
}
