import assert from "node:assert/strict";

// The shared shipping fixture binds a public alias. This deliberately private
// SDK prototype must bind its exact local archive instead, without dropping any
// of the shared runtime, Zod, Effect, TOML, no-override or host-contract checks.
export function bindLocalSdkFixture(source, artifact, sdkReference) {
  assert.ok(sdkReference.startsWith("file:"), "SDK prototype requires its exact private archive edge");
  const escapedName = artifact.name.replaceAll("/", "\\/");
  const original = ` assert.match(declaredPlugin,/^npm:${escapedName}@/);\n const declaredVersion=declaredPlugin.slice(declaredPlugin.lastIndexOf("@")+1);`;
  assert.equal(source.split(original).length, 2, "SDK fixture oracle drift");
  const versionBinding = ` const declaredVersion=${JSON.stringify(artifact.version)};`;
  const replacement = [
    ` assert.equal(declaredPlugin, ${JSON.stringify(sdkReference)});`, versionBinding,
    ` assert.equal(parent.name, ${JSON.stringify(artifact.name)});`,
    ` assert.equal(parent.dependencies.zod, ${JSON.stringify(artifact.zod)});`,
    ` assert.equal(pluginRequire("zod/package.json").version, ${JSON.stringify(artifact.zod)});`,
    ` assert.equal(parent.dependencies.effect, ${JSON.stringify(artifact.effectAlias)});`,
  ].join("\n");
  return { text: source.replace(original, replacement), versionBinding, replacement };
}
