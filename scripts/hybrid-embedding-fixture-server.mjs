#!/usr/bin/env node
import http from "node:http";

const port = Number(process.env.HYBRID_FIXTURE_PORT || 19876);
const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/embeddings") {
    response.writeHead(404).end();
    return;
  }
  process.stdout.write("request\n");
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: payload.model,
        model_revision: "fixture-r1",
        data: [{ index: 0, embedding: [1, 2, 3] }],
      }));
    } catch {
      response.writeHead(400).end();
    }
  });
});
server.listen(port, "127.0.0.1", () => process.stdout.write("ready\n"));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
