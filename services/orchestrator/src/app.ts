import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadConfig } from "./config.js";
import type { RoomSnapshot, RoomState } from "./domain.js";
import { PayoutGateway } from "./payout.js";
import { fixture, replayEvents, replayQuests } from "./replay.js";
import { createStore, verifyRoomToken } from "./store.js";
import { TxLineClient } from "./txline.js";

export async function createCrowdQuestApp(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, trustProxy: true, bodyLimit: 16_384 });
  const store = await createStore(config.DATABASE_URL, config.sessionTtlMs, config.answerWindowMs);
  const txline = new TxLineClient(config.TXLINE_ORIGIN, config.TXLINE_API_TOKEN, config.TXLINE_FIXTURE_ID);
  const payouts = new PayoutGateway(config.PAYOUT_MODE, config.MAX_PAYOUT_USDC, config.COINBASE_AGENT_URL, config.COINBASE_AGENT_TOKEN);
  const cleanupTimer = setInterval(() => {
    void store.purgeExpired()
      .then((deleted) => { if (deleted > 0) app.log.info({ deleted }, "expired sessions purged"); })
      .catch((error) => app.log.error({ err: error }, "session cleanup failed"));
  }, config.sessionCleanupMs);
  cleanupTimer.unref();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : undefined;
    const errorCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
    if (statusCode === 429) return reply.code(429).send({ error: "rate_limited", retryAfter: reply.getHeader("retry-after") });
    if (errorCode === "ORIGIN_NOT_ALLOWED") return reply.code(403).send({ error: "origin_not_allowed" });
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: "internal_error" });
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      callback(Object.assign(new Error("Origin not allowed"), { statusCode: 403, code: "ORIGIN_NOT_ALLOWED" }), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    cache: 10_000,
    errorResponseBuilder: (_request, context) => Object.assign(new Error("Rate limit exceeded"), { statusCode: context.statusCode, code: "RATE_LIMITED" }),
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  app.get("/healthz", async (_request, reply) => {
    const databaseReady = await store.health();
    if (!databaseReady) reply.code(503);
    return { status: databaseReady ? "ok" : "degraded", service: "crowdquest-orchestrator", databaseReady, txlineConfigured: txline.configured, time: new Date().toISOString() };
  });

  app.get("/v1/source", async () => txline.status());

  app.post("/v1/sessions", { config: { rateLimit: { max: config.SESSION_CREATE_RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS } } }, async (request, reply) => {
    const input = z.object({ displayName: z.string().trim().min(1).max(32).default("Guest fan") }).parse(request.body ?? {});
    const { state, accessToken } = await store.create(input.displayName);
    reply.code(201);
    return { room: await snapshot(state), accessToken };
  });

  app.get<{ Params: { sessionId: string } }>("/v1/rooms/:sessionId", async (request, reply) => {
    const state = await ownedRoom(request, reply);
    if (!state) return;
    return snapshot(state);
  });

  app.post<{ Params: { sessionId: string } }>("/v1/rooms/:sessionId/answers", async (request, reply) => {
    const input = z.object({ questId: z.string().min(1).max(80), choiceId: z.string().min(1).max(40) }).parse(request.body);
    const state = await ownedRoom(request, reply);
    if (!state) return;
    const quest = replayQuests[state.eventIndex];
    if (!quest) return reply.code(409).send({ error: "room_finished" });
    if (!state.questClosesAt || Date.parse(state.questClosesAt) <= Date.now()) return reply.code(409).send({ error: "answer_window_closed" });
    if (input.questId !== quest.id) return reply.code(409).send({ error: "stale_quest", activeQuestId: quest.id });
    if (!quest.choices.some((choice) => choice.id === input.choiceId)) return reply.code(400).send({ error: "invalid_choice" });
    const expectedVersion = state.version;
    const txlineTruth = await txline.resolveQuest(quest.id);
    const correct = input.choiceId === (txlineTruth?.choiceId ?? quest.correctChoice);
    const nextEvent = replayEvents[Math.min(state.eventIndex + 1, replayEvents.length - 1)];
    state.answers.push({
      questId: quest.id,
      choiceId: input.choiceId,
      correct,
      points: correct ? quest.points : 0,
      settledAt: new Date().toISOString(),
      source: txlineTruth ? "txline" : "replay",
      sourceSequence: txlineTruth?.sourceSequence ?? nextEvent.txlineSeq,
    });
    state.points += correct ? quest.points : 0;
    state.streak = correct ? state.streak + 1 : 0;
    state.eventIndex = Math.min(state.eventIndex + 1, replayEvents.length - 1);
    state.questClosesAt = state.eventIndex < replayQuests.length ? new Date(Date.now() + config.answerWindowMs).toISOString() : null;
    state.version += 1;
    state.updatedAt = new Date().toISOString();
    if (!await store.save(state, expectedVersion)) return reply.code(409).send({ error: "concurrent_update" });
    const room = await snapshot(state);
    const payoutIntent = room.finished ? await payouts.createIntent(state.id, fixture.sponsorPoolUsdc) : null;
    return { room, settlement: state.answers.at(-1), payoutIntent };
  });

  app.post<{ Params: { sessionId: string } }>("/v1/rooms/:sessionId/reset", async (request, reply) => {
    const state = await ownedRoom(request, reply);
    if (!state) return;
    const expectedVersion = state.version;
    Object.assign(state, { eventIndex: 0, points: 860, streak: 3, answers: [], questClosesAt: new Date(Date.now() + config.answerWindowMs).toISOString(), version: state.version + 1, updatedAt: new Date().toISOString() });
    if (!await store.save(state, expectedVersion)) return reply.code(409).send({ error: "concurrent_update" });
    return snapshot(state);
  });

  app.post<{ Params: { sessionId: string } }>("/v1/rooms/:sessionId/window", async (request, reply) => {
    const state = await ownedRoom(request, reply);
    if (!state) return;
    if (!replayQuests[state.eventIndex]) return reply.code(409).send({ error: "room_finished" });
    const expectedVersion = state.version;
    state.questClosesAt = new Date(Date.now() + config.answerWindowMs).toISOString();
    state.version += 1;
    state.updatedAt = new Date().toISOString();
    if (!await store.save(state, expectedVersion)) return reply.code(409).send({ error: "concurrent_update" });
    return snapshot(state);
  });

  app.post("/v1/admin/txline/refresh", { config: { rateLimit: { max: 6, timeWindow: config.RATE_LIMIT_WINDOW_MS } } }, async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!config.ADMIN_TOKEN || token !== config.ADMIN_TOKEN) return reply.code(401).send({ error: "unauthorized" });
    const projection = await txline.fixtureProjection(true);
    return {
      fixtureId: config.TXLINE_FIXTURE_ID,
      normalizedEvents: projection.eventCount,
      authoritativeQuests: projection.resolutions.size,
      actions: projection.actions,
      loadedAt: projection.loadedAt,
    };
  });

  async function snapshot(state: RoomState): Promise<RoomSnapshot> {
    const event = replayEvents[state.eventIndex] ?? replayEvents.at(-1)!;
    return {
      session: { id: state.id, displayName: state.displayName, points: state.points, streak: state.streak, expiresAt: state.expiresAt },
      match: fixture,
      event,
      eventIndex: state.eventIndex,
      eventCount: replayEvents.length,
      questClosesAt: state.questClosesAt,
      quest: publicQuest(replayQuests[state.eventIndex]),
      finished: state.eventIndex === replayEvents.length - 1,
      answers: state.answers,
      source: await txline.status(),
    };
  }

  async function ownedRoom(request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply): Promise<RoomState | null> {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]{40,128})$/);
    if (!match) {
      reply.header("WWW-Authenticate", 'Bearer realm="crowdquest-room"').code(401).send({ error: "session_token_required" });
      return null;
    }
    const state = await store.get(request.params.sessionId);
    if (!state || !verifyRoomToken(state, match[1])) {
      reply.code(404).send({ error: "session_not_found" });
      return null;
    }
    return state;
  }

  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    txline.stop();
    await store.close();
  });

  return { app, startSourceStream: () => txline.startScoreStream() };
}

function publicQuest(quest: typeof replayQuests[number] | undefined): RoomSnapshot["quest"] {
  if (!quest) return null;
  return {
    id: quest.id,
    prompt: quest.prompt,
    context: quest.context,
    choices: quest.choices,
    points: quest.points,
    settlesOn: quest.settlesOn,
  };
}
