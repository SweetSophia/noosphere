// Deliberately out-of-range edges qualified together with KaTeX. A changed
// parent range requires re-qualification, not ordinary semver satisfaction.
export const approvedKatexRanges = Object.freeze({
  mermaid: "^0.16.47",
  "rehype-katex": "^0.16.0",
  "micromark-extension-math": "^0.16.0",
});
export const approvedKatexVersion = "0.18.2";
export function katexOverrideFailures(manifest, lock) {
  const errors = [];
  if (manifest.dependencies?.katex !== approvedKatexVersion) errors.push("Root KaTeX must keep the exact qualified pin; re-qualify before changing it.");
  for (const [parent, range] of Object.entries(approvedKatexRanges)) {
    if (manifest.overrides?.[parent]?.katex !== "$katex") errors.push(`${parent} must retain its qualified parent-scoped $katex override.`);
    if (lock.packages?.[`node_modules/${parent}`]?.dependencies?.katex !== range) errors.push(`${parent}'s declared KaTeX range changed; re-qualify its forced edge and update the reviewed policy.`);
  }
  const entries = Object.entries(lock.packages ?? {}).filter(([name]) => /(?:^|\/)node_modules\/katex$/.test(name));
  if (!entries.some(([name]) => name === "node_modules/katex")) errors.push("The qualified root KaTeX lock entry is missing.");
  for (const [name, entry] of entries) if (entry.version !== approvedKatexVersion) errors.push(`${name} is not the qualified KaTeX ${approvedKatexVersion}.`);
  return errors;
}
