import type { MatchEvent } from "./domain.js";

export type QuestTruth = {
  choiceId: string;
  sourceSequence?: number;
  derivedFrom: string;
};

export type FixtureProjection = {
  eventCount: number;
  actions: string[];
  loadedAt: string;
  resolutions: Map<string, QuestTruth>;
};

/**
 * Converts normalized TxLINE score updates into the exact facts used by the
 * CrowdQuest demo. A quest is omitted when the feed does not contain enough
 * evidence; callers must then disclose and use the authored replay fallback.
 */
export function projectFixture(events: MatchEvent[]): FixtureProjection {
  const ordered = dedupe(events).sort((left, right) =>
    (left.txlineSeq ?? left.minute) - (right.txlineSeq ?? right.minute));
  const resolutions = new Map<string, QuestTruth>();

  const penalty = ordered.find((event) =>
    event.minute >= 27 && event.minute <= 30 &&
    /penalty|spot.?kick|shot|save|miss/.test(event.txlineAction ?? ""));
  if (penalty) {
    const previous = previousEvent(ordered, penalty);
    const scored = totalGoals(penalty) > totalGoals(previous);
    resolutions.set("penalty-result", truth(scored ? "yes" : "no", penalty, "penalty score delta"));
  }

  const halfTime = ordered.find((event) => event.kind === "break");
  if (halfTime) {
    resolutions.set("before-break", truth(totalGoals(halfTime) > 0 ? "yes" : "no", halfTime, "half-time score"));
  }

  const firstGoal = ordered.find((event) => totalGoals(event) >= 1);
  if (firstGoal) {
    resolutions.set("opener-window", truth(firstGoal.minute < 65 ? "yes" : "no", firstGoal, "first score update"));
  }

  const secondGoal = firstGoal && ordered.find((event) =>
    (event.txlineSeq ?? event.minute) > (firstGoal.txlineSeq ?? firstGoal.minute) && totalGoals(event) >= 2);
  if (firstGoal && secondGoal) {
    resolutions.set("quick-followup", truth(secondGoal.minute - firstGoal.minute <= 10 ? "yes" : "no", secondGoal, "second score update"));
  }

  const final = last(ordered.filter((event) => event.kind === "final"))
    ?? last(ordered.filter((event) => event.minute >= 90));
  if (final) {
    const margin = final.homeScore - final.awayScore;
    const choiceId = margin >= 2 ? "two-plus" : margin === 1 ? "one" : "other";
    resolutions.set("final-margin", truth(choiceId, final, "final score"));
  }

  return {
    eventCount: ordered.length,
    actions: [...new Set(ordered.map((event) => event.txlineAction).filter((value): value is string => Boolean(value)))],
    loadedAt: new Date().toISOString(),
    resolutions,
  };
}

function truth(choiceId: string, event: MatchEvent, derivedFrom: string): QuestTruth {
  return { choiceId, sourceSequence: event.txlineSeq, derivedFrom };
}

function totalGoals(event?: MatchEvent) {
  return event ? event.homeScore + event.awayScore : 0;
}

function previousEvent(events: MatchEvent[], event: MatchEvent) {
  const index = events.indexOf(event);
  return index > 0 ? events[index - 1] : undefined;
}

function last<T>(values: T[]) {
  return values.at(-1);
}

function dedupe(events: MatchEvent[]) {
  const unique = new Map<string, MatchEvent>();
  for (const event of events) unique.set(`${event.txlineSeq ?? "none"}:${event.id}`, event);
  return [...unique.values()];
}
