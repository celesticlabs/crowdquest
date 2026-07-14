import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScoreRecord, parseHistoricalPayload } from "../src/txline.js";

test("normalizes a TxLINE soccer goal without exposing raw data", () => {
  const event = normalizeScoreRecord({
    fixtureId: 18209181,
    action: "goal",
    seq: 404,
    dataSoccer: { Minutes: 60 },
    scoreSoccer: {
      Participant1: { Total: { Goals: 1 } },
      Participant2: { Total: { Goals: 0 } },
    },
  }, 18209181);
  assert.deepEqual(event, {
    id: "txline-404",
    minute: 60,
    minuteLabel: "60′",
    title: "Goal",
    detail: "Normalized from the TxLINE scores feed.",
    kind: "goal",
    homeScore: 1,
    awayScore: 0,
    marketHome: 0,
    txlineSeq: 404,
    txlineAction: "goal",
  });
});

test("rejects a record from another fixture", () => {
  assert.equal(normalizeScoreRecord({ fixtureId: 1 }, 18209181), null);
});

test("normalizes the production TxLINE PascalCase score contract", () => {
  const event = normalizeScoreRecord({
    FixtureId: 18209181,
    Action: "goal",
    Confirmed: true,
    Seq: 739,
    Clock: { Running: true, Seconds: 3560 },
    Score: {
      Participant1: { Total: { Goals: 1, Corners: 3 } },
      Participant2: { Total: { Corners: 2 } },
    },
    Data: { GoalType: "Shot" },
  }, 18209181);
  assert.equal(event?.id, "txline-739");
  assert.equal(event?.minute, 59);
  assert.equal(event?.homeScore, 1);
  assert.equal(event?.awayScore, 0);
  assert.equal(event?.txlineAction, "goal");
});

test("rejects provisional TxLINE events until they are confirmed", () => {
  assert.equal(normalizeScoreRecord({
    FixtureId: 18209181,
    Action: "goal",
    Confirmed: false,
    Seq: 534,
    Clock: { Seconds: 2924 },
    Score: { Participant2: { Total: { Goals: 1 } } },
  }, 18209181), null);
});

test("parses TxLINE historical SSE replay frames", () => {
  const records = parseHistoricalPayload([
    'data: {"FixtureId":18209181,"Action":"penalty_outcome","Confirmed":true,"Seq":323}',
    "id: 323",
    "",
    'data: {"FixtureId":18209181,"Action":"goal","Confirmed":true,"Seq":739}',
    "id: 739",
    "",
  ].join("\n"), "text/event-stream");
  assert.deepEqual(records, [
    { FixtureId: 18209181, Action: "penalty_outcome", Confirmed: true, Seq: 323 },
    { FixtureId: 18209181, Action: "goal", Confirmed: true, Seq: 739 },
  ]);
});

test("recognizes the production half-time status frame", () => {
  const event = normalizeScoreRecord({
    FixtureId: 18209181,
    Action: "status",
    Seq: 553,
    Clock: { Running: false, Seconds: 2700 },
    Data: { StatusId: 4 },
    Score: {
      Participant1: { Total: { Goals: 0 } },
      Participant2: { Total: { Goals: 0 } },
    },
  }, 18209181);
  assert.equal(event?.minute, 45);
  assert.equal(event?.kind, "break");
});
