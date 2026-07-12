import type { MatchEvent, SourceStatus } from "./domain.js";
import { projectFixture, type FixtureProjection, type QuestTruth } from "./projection.js";

type JsonObject = Record<string, unknown>;

export class TxLineClient {
  #jwt: string | null = null;
  #lastCheck: SourceStatus | null = null;
  #events: MatchEvent[] = [];
  #projection: FixtureProjection | null = null;
  #projectionLoad: Promise<FixtureProjection> | null = null;
  #streamAbort: AbortController | null = null;
  #streamConnected = false;

  constructor(
    private readonly origin: string,
    private readonly apiToken: string | undefined,
    private readonly fixtureId: number,
  ) {}

  get configured() { return Boolean(this.apiToken); }

  async status(): Promise<SourceStatus> {
    if (!this.apiToken) return this.buildStatus(false, "replay");
    if (this.#lastCheck && Date.now() - Date.parse(this.#lastCheck.lastCheckedAt) < 30_000) return this.#lastCheck;
    try {
      await this.request("/api/fixtures/snapshot");
      const projection = await this.fixtureProjection();
      const authoritative = projection.eventCount > 0 && projection.resolutions.size > 0;
      this.#lastCheck = this.buildStatus(authoritative, authoritative ? "live" : "replay");
    } catch {
      this.#lastCheck = this.buildStatus(false, "replay");
    }
    return this.#lastCheck;
  }

  async historicalEvents(): Promise<MatchEvent[]> {
    if (!this.apiToken) return [];
    const raw = await this.request(`/api/scores/historical/${this.fixtureId}`);
    if (!Array.isArray(raw)) return [];
    const events = raw.map((record) => normalizeScoreRecord(record, this.fixtureId)).filter((event): event is MatchEvent => Boolean(event));
    this.mergeEvents(events);
    return events;
  }

  async fixtureProjection(force = false): Promise<FixtureProjection> {
    if (!force && this.#projection) return this.#projection;
    if (!force && this.#projectionLoad) return this.#projectionLoad;
    this.#projectionLoad = (async () => {
      if (force) this.#events = [];
      await this.historicalEvents();
      this.#projection = projectFixture(this.#events);
      this.#lastCheck = null;
      return this.#projection;
    })();
    try {
      return await this.#projectionLoad;
    } finally {
      this.#projectionLoad = null;
    }
  }

  async resolveQuest(questId: string): Promise<QuestTruth | null> {
    if (!this.apiToken) return null;
    try {
      return (await this.fixtureProjection()).resolutions.get(questId) ?? null;
    } catch {
      return null;
    }
  }

  startScoreStream() {
    if (!this.apiToken || this.#streamAbort) return;
    this.#streamAbort = new AbortController();
    void this.streamScores(this.#streamAbort.signal);
  }

  stop() {
    this.#streamAbort?.abort();
    this.#streamAbort = null;
    this.#streamConnected = false;
  }

  private buildStatus(connected: boolean, mode: "live" | "replay"): SourceStatus {
    return {
      provider: "TxLINE",
      connected,
      mode,
      fixtureId: this.fixtureId,
      lastCheckedAt: new Date().toISOString(),
      endpoints: ["/api/fixtures/snapshot", `/api/scores/historical/${this.fixtureId}`, `/api/odds/snapshot/${this.fixtureId}`, "/api/scores/stream"],
      normalizedEvents: this.#projection?.eventCount ?? this.#events.length,
      authoritativeQuests: this.#projection?.resolutions.size ?? 0,
      streaming: this.#streamConnected,
    };
  }

  private mergeEvents(events: MatchEvent[]) {
    const unique = new Map(this.#events.map((event) => [`${event.txlineSeq ?? "none"}:${event.id}`, event]));
    for (const event of events) unique.set(`${event.txlineSeq ?? "none"}:${event.id}`, event);
    this.#events = [...unique.values()];
    this.#projection = projectFixture(this.#events);
    this.#lastCheck = null;
  }

  private async streamScores(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const response = await this.openScoreStream(signal);
        if (!response.body) throw new Error("TxLINE score stream returned no body");
        this.#streamConnected = true;
        await this.consumeSse(response.body, signal);
      } catch {
        this.#streamConnected = false;
        if (signal.aborted) return;
        await abortableDelay(5_000, signal);
      } finally {
        this.#streamConnected = false;
      }
    }
  }

  private async openScoreStream(signal: AbortSignal, retry = true): Promise<Response> {
    if (!this.apiToken) throw new Error("TxLINE API token is not configured");
    const jwt = await this.guestJwt();
    const url = new URL("/api/scores/stream", this.origin);
    url.searchParams.set("fixtureId", String(this.fixtureId));
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Api-Token": this.apiToken,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
      signal,
    });
    if ((response.status === 401 || response.status === 403) && retry) {
      this.#jwt = null;
      return this.openScoreStream(signal, false);
    }
    if (!response.ok) throw new Error(`TxLINE score stream failed with ${response.status}`);
    return response;
  }

  private async consumeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart()).join("\n");
          if (data) {
            try {
              const event = normalizeScoreRecord(JSON.parse(data), this.fixtureId);
              if (event) this.mergeEvents([event]);
            } catch {
              // Heartbeats and malformed frames are ignored; the stream remains usable.
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async guestJwt() {
    if (this.#jwt) return this.#jwt;
    const response = await fetch(`${this.origin}/auth/guest/start`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`TxLINE guest auth failed with ${response.status}`);
    const body = await response.json() as { token?: string };
    if (!body.token) throw new Error("TxLINE guest auth returned no token");
    this.#jwt = body.token;
    return body.token;
  }

  private async request(path: string, retry = true): Promise<unknown> {
    if (!this.apiToken) throw new Error("TxLINE API token is not configured");
    const jwt = await this.guestJwt();
    const response = await fetch(`${this.origin}${path}`, {
      headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": this.apiToken, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 && retry) {
      this.#jwt = null;
      return this.request(path, false);
    }
    if (!response.ok) throw new Error(`TxLINE ${path} failed with ${response.status}`);
    return response.json();
  }
}

export function normalizeScoreRecord(input: unknown, fixtureId: number): MatchEvent | null {
  if (!isObject(input) || Number(input.fixtureId) !== fixtureId) return null;
  const score = isObject(input.scoreSoccer) ? input.scoreSoccer : {};
  const p1 = nestedGoals(score, "Participant1");
  const p2 = nestedGoals(score, "Participant2");
  const data = isObject(input.dataSoccer) ? input.dataSoccer : {};
  const action = String(data.Action ?? input.action ?? "update").toLowerCase();
  const minute = integer(data.Minutes) ?? minuteFromClock(input.clock) ?? 0;
  const kind: MatchEvent["kind"] = action.includes("final") ? "final" : action.includes("goal") ? "goal" : action.includes("penalty") || action.includes("shot") ? "chance" : action.includes("half") ? "break" : "kickoff";
  return {
    id: `txline-${integer(input.seq) ?? integer(input.id) ?? minute}`,
    minute,
    minuteLabel: kind === "final" ? "FT" : kind === "break" ? "HT" : `${minute}′`,
    title: humanizeAction(action),
    detail: "Normalized from the TxLINE scores feed.",
    kind,
    homeScore: p1,
    awayScore: p2,
    marketHome: 0,
    txlineSeq: integer(input.seq),
    txlineAction: action,
  };
}

function nestedGoals(score: JsonObject, participant: string) {
  const value = isObject(score[participant]) ? score[participant] : {};
  const total = isObject(value.Total) ? value.Total : {};
  return integer(total.Goals) ?? 0;
}
function minuteFromClock(value: unknown) { return isObject(value) ? Math.floor((integer(value.seconds) ?? 0) / 60) : undefined; }
function integer(value: unknown) { const number = Number(value); return Number.isInteger(number) ? number : undefined; }
function isObject(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function humanizeAction(action: string) { return action.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
}
