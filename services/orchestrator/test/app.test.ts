import assert from "node:assert/strict";
import test from "node:test";
import { createCrowdQuestApp } from "../src/app.js";
import { MemoryRoomStore, verifyRoomToken } from "../src/store.js";

const baseEnv: NodeJS.ProcessEnv = {
  LOG_LEVEL: "silent",
  CORS_ORIGINS: "https://allowed.example",
  SESSION_TTL_HOURS: "24",
  SESSION_CLEANUP_MINUTES: "60",
  RATE_LIMIT_MAX: "120",
  RATE_LIMIT_WINDOW_MS: "60000",
  SESSION_CREATE_RATE_LIMIT_MAX: "12",
  ANSWER_WINDOW_SECONDS: "24",
  TXLINE_ORIGIN: "https://txline-dev.txodds.com",
  TXLINE_FIXTURE_ID: "18209181",
  PAYOUT_MODE: "disabled",
  MAX_PAYOUT_USDC: "20",
};

test("creates an expiring bearer-owned room without exposing private state", async (context) => {
  const { app } = await createCrowdQuestApp(baseEnv);
  context.after(() => app.close());

  const created = await app.inject({ method: "POST", url: "/v1/sessions", payload: { displayName: "Audit fan" } });
  assert.equal(created.statusCode, 201);
  const body = created.json();
  assert.match(body.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(body.room.session.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(body), /accessTokenHash|correctChoice/);

  const missingToken = await app.inject({ method: "GET", url: `/v1/rooms/${body.room.session.id}` });
  assert.equal(missingToken.statusCode, 401);
  assert.equal(missingToken.headers["www-authenticate"], 'Bearer realm="crowdquest-room"');

  const invalidToken = await app.inject({ method: "GET", url: `/v1/rooms/${body.room.session.id}`, headers: { authorization: `Bearer ${"x".repeat(43)}` } });
  assert.equal(invalidToken.statusCode, 404);

  const owned = await app.inject({ method: "GET", url: `/v1/rooms/${body.room.session.id}`, headers: { authorization: `Bearer ${body.accessToken}` } });
  assert.equal(owned.statusCode, 200);
  assert.equal(owned.json().session.displayName, "Audit fan");
});

test("rejects concurrent answer replays with optimistic room versioning", async (context) => {
  const { app } = await createCrowdQuestApp(baseEnv);
  context.after(() => app.close());
  const created = (await app.inject({ method: "POST", url: "/v1/sessions", payload: {} })).json();
  const request = {
    method: "POST" as const,
    url: `/v1/rooms/${created.room.session.id}/answers`,
    headers: { authorization: `Bearer ${created.accessToken}` },
    payload: { questId: "penalty-result", choiceId: "no" },
  };

  const responses = await Promise.all([app.inject(request), app.inject(request)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);

  const room = await app.inject({ method: "GET", url: `/v1/rooms/${created.room.session.id}`, headers: request.headers });
  assert.equal(room.json().session.points, 1_000);
  assert.equal(room.json().answers.length, 1);
});

test("returns controlled CORS and rate-limit errors", async (context) => {
  const { app } = await createCrowdQuestApp({ ...baseEnv, SESSION_CREATE_RATE_LIMIT_MAX: "2" });
  context.after(() => app.close());

  const blocked = await app.inject({ method: "GET", url: "/v1/source", headers: { origin: "https://evil.example" } });
  assert.equal(blocked.statusCode, 403);
  assert.deepEqual(blocked.json(), { error: "origin_not_allowed" });

  const allowed = await app.inject({ method: "GET", url: "/v1/source", headers: { origin: "https://allowed.example" } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers["access-control-allow-origin"], "https://allowed.example");

  assert.equal((await app.inject({ method: "POST", url: "/v1/sessions", payload: {} })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/v1/sessions", payload: {} })).statusCode, 201);
  const limited = await app.inject({ method: "POST", url: "/v1/sessions", payload: {} });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error, "rate_limited");
});

test("enforces and safely reopens server answer windows", async (context) => {
  const { app } = await createCrowdQuestApp({ ...baseEnv, ANSWER_WINDOW_SECONDS: "1" });
  context.after(() => app.close());
  const created = (await app.inject({ method: "POST", url: "/v1/sessions", payload: {} })).json();
  const headers = { authorization: `Bearer ${created.accessToken}` };
  await new Promise((resolve) => setTimeout(resolve, 1_050));

  const closed = await app.inject({ method: "POST", url: `/v1/rooms/${created.room.session.id}/answers`, headers, payload: { questId: "penalty-result", choiceId: "no" } });
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().error, "answer_window_closed");

  const reopened = await app.inject({ method: "POST", url: `/v1/rooms/${created.room.session.id}/window`, headers });
  assert.equal(reopened.statusCode, 200);
  assert.ok(Date.parse(reopened.json().questClosesAt) > Date.now());

  const answered = await app.inject({ method: "POST", url: `/v1/rooms/${created.room.session.id}/answers`, headers, payload: { questId: "penalty-result", choiceId: "no" } });
  assert.equal(answered.statusCode, 200);
});

test("expires memory sessions and enforces compare-and-swap writes", async () => {
  const store = new MemoryRoomStore(25, 24_000);
  const created = await store.create("Short session");
  assert.equal(verifyRoomToken(created.state, created.accessToken), true);
  assert.equal(await store.save({ ...created.state, version: 1 }, 4), false);
  assert.equal(await store.save({ ...created.state, version: 1 }, 0), true);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(await store.get(created.state.id), null);
  await store.close();
});
