import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../src/index.js";

test("public package surface does not expose the credentialed REST client", () => {
  assert.deepEqual(Object.keys(publicApi).sort(), ["createNoosphereMcpServer"]);
});
