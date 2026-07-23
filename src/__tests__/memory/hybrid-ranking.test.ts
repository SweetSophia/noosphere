import assert from "node:assert/strict";
import test from "node:test";

import {
  HYBRID_CANDIDATE_DEPTH,
  HYBRID_MAX_WINDOW,
  HYBRID_RRF_K,
  HYBRID_VECTOR_AUTH_BATCH_SIZE,
} from "@/lib/memory/hybrid-ranking";

test("Phase C pins the accepted RRF constants", () => {
  assert.equal(HYBRID_RRF_K, 60);
  assert.equal(HYBRID_CANDIDATE_DEPTH, 200);
  assert.equal(HYBRID_MAX_WINDOW, 200);
  assert.equal(HYBRID_VECTOR_AUTH_BATCH_SIZE, 1_000);
});
