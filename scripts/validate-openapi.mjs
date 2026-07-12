import { readFile } from "node:fs/promises";

const path = new URL("../openapi/crowdquest.openapi.json", import.meta.url);
const spec = JSON.parse(await readFile(path, "utf8"));
const expectedOperations = [
  ["/healthz", "get"],
  ["/v1/source", "get"],
  ["/v1/sessions", "post"],
  ["/v1/rooms/{sessionId}", "get"],
  ["/v1/rooms/{sessionId}/answers", "post"],
  ["/v1/rooms/{sessionId}/reset", "post"],
  ["/v1/rooms/{sessionId}/window", "post"],
  ["/v1/admin/txline/refresh", "post"],
];

if (spec.openapi !== "3.1.0") throw new Error("OpenAPI version must be 3.1.0");
if (spec.info?.version !== "1.0.0") throw new Error("Production API contract must be version 1.0.0");
for (const [route, method] of expectedOperations) {
  if (!spec.paths?.[route]?.[method]) throw new Error(`Missing ${method.toUpperCase()} ${route}`);
}
const publicQuest = spec.components?.schemas?.PublicQuest;
if (!publicQuest || "correctChoice" in (publicQuest.properties ?? {})) {
  throw new Error("PublicQuest must exist and must never expose correctChoice");
}
const answerInput = spec.components?.schemas?.AnswerInput;
for (const required of ["questId", "choiceId"]) {
  if (!answerInput?.required?.includes(required)) throw new Error(`AnswerInput must require ${required}`);
}
if (!spec.components?.securitySchemes?.sessionBearer) throw new Error("Room endpoints must define sessionBearer security");
for (const [route, method] of [
  ["/v1/rooms/{sessionId}", "get"],
  ["/v1/rooms/{sessionId}/answers", "post"],
  ["/v1/rooms/{sessionId}/reset", "post"],
  ["/v1/rooms/{sessionId}/window", "post"],
]) {
  const security = spec.paths?.[route]?.[method]?.security;
  if (!security?.some((entry) => "sessionBearer" in entry)) throw new Error(`${method.toUpperCase()} ${route} must require sessionBearer`);
}
if (spec.paths?.["/v1/sessions"]?.post?.responses?.["201"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/CreateSessionResponse") {
  throw new Error("Session creation must return the one-time room bearer token contract");
}

process.stdout.write("OpenAPI contract checks passed.\n");
