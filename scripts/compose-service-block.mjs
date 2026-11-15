// Extract one service block from a Compose file so a policy assertion can
// target that service instead of matching anywhere in the document.
//
// The block ends at the next service header at the same indentation. That
// header pattern is deliberately broad - `  db:`, `  db: {image: ...}` and
// `  db:  # database` all end the block - because a narrow pattern stops
// matching after a reformat, the block silently widens into the following
// service, and a guard whose whole job is proving *the worker is capped*
// ends up proving *some service in this file mentions max-size 10m*.
//
// Returns null when the service key is absent, so the caller can report a
// missing service instead of reporting a missing cap.
export function composeServiceBlock(composeText, service) {
  const lines = composeText.split("\n");
  const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp("^  " + escaped + ":").test(line));
  if (start === -1) {
    return null;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[a-zA-Z0-9_.-]+:/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}
