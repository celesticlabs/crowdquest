"use client";

import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  events,
  leaderboard,
  match,
  quests,
  toolTrace,
} from "@/lib/demo-data";
import { Icon } from "./icons";
import { BrandLogo } from "./brand-logo";

type View = "room" | "signal" | "trace";
type SourceState = "connecting" | "live" | "replay" | "local";
type OperationTone = "info" | "success" | "warning";

type SettledAnswer = {
  questId: string;
  choice: string;
  correct: boolean;
  points: number;
};

type ApiRoom = {
  session: { id: string; points: number; streak: number; expiresAt: string };
  eventIndex: number;
  questClosesAt: string | null;
  source: { connected: boolean; mode: "live" | "replay" };
  answers: Array<{ questId: string; choiceId: string; correct: boolean; points: number }>;
};

type CreateSessionResponse = { room: ApiRoom; accessToken: string };

const API_BASE = process.env.NEXT_PUBLIC_CROWDQUEST_API_URL ?? "";
const POLAR_CHECKOUT_URL = process.env.NEXT_PUBLIC_POLAR_CHECKOUT_URL;
const LOCAL_ANSWER_WINDOW_SECONDS = 24;

const EVENT_COLORS = {
  kickoff: "event-neutral",
  chance: "event-amber",
  break: "event-neutral",
  goal: "event-lime",
  final: "event-violet",
};

export function MatchRoom() {
  const [view, setView] = useState<View>("room");
  const [eventIndex, setEventIndex] = useState(0);
  const [choice, setChoice] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(LOCAL_ANSWER_WINDOW_SECONDS);
  const [points, setPoints] = useState(860);
  const [streak, setStreak] = useState(3);
  const [answers, setAnswers] = useState<SettledAnswer[]>([]);
  const [lastResult, setLastResult] = useState<SettledAnswer | null>(null);
  const [apiSessionId, setApiSessionId] = useState<string | null>(null);
  const [apiSessionToken, setApiSessionToken] = useState<string | null>(null);
  const [apiAvailable, setApiAvailable] = useState(false);
  const [sourceConnected, setSourceConnected] = useState(false);
  const [connectionPending, setConnectionPending] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [operationMessage, setOperationMessage] = useState("Connecting to the replay service…");
  const [operationTone, setOperationTone] = useState<OperationTone>("info");

  const event = events[eventIndex];
  const quest = eventIndex < quests.length ? quests[eventIndex] : null;
  const finished = eventIndex === events.length - 1;
  const timedOut = seconds === 0;
  const sourceState: SourceState = connectionPending
    ? "connecting"
    : sourceConnected
      ? "live"
      : apiAvailable
        ? "replay"
        : "local";

  const sourceCopy = {
    connecting: {
      label: "Checking source",
      title: "Connecting to the CrowdQuest session service",
      detail: "The product will fall back to the bundled deterministic replay if the adapter is unavailable.",
    },
    live: {
      label: "Live source",
      title: "TxLINE adapter connected",
      detail: "Current fixture state is normalized server-side before it reaches this workspace.",
    },
    replay: {
      label: "API replay",
      title: "Historical fixture via the replay adapter",
      detail: "This is a completed fixture demonstration—not a live match or live market.",
    },
    local: {
      label: "Local replay",
      title: "Bundled deterministic fixture",
      detail: "The API adapter is unavailable, so the same test scenario is running locally.",
    },
  }[sourceState];

  useEffect(() => {
    if (!quest || submitting) return;
    const timer = window.setInterval(() => {
      setSeconds((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [quest, submitting, eventIndex]);

  useEffect(() => {
    let cancelled = false;
    async function createSession() {
      try {
        const response = await fetch(`${API_BASE}/v1/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: "Guest fan" }),
        });
        if (!response.ok) throw new Error(`session request failed: ${response.status}`);
        const payload = await response.json() as CreateSessionResponse;
        if (!payload.accessToken) throw new Error("session response did not include room authority");
        const room = payload.room;
        if (cancelled) return;
        setApiSessionId(room.session.id);
        setApiSessionToken(payload.accessToken);
        setApiAvailable(true);
        setSourceConnected(room.source.connected);
        setConnectionPending(false);
        setSeconds(secondsUntil(room.questClosesAt));
        setOperationMessage(room.source.connected ? "TxLINE source connected through the server adapter." : "Replay adapter responded and is ready.");
        setOperationTone(room.source.connected ? "success" : "info");
      } catch {
        if (!cancelled) {
          setApiAvailable(false);
          setSourceConnected(false);
          setConnectionPending(false);
          setOperationMessage("Replay service unavailable. Continuing with the local deterministic replay.");
          setOperationTone("warning");
        }
      }
    }
    void createSession();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!quest || timedOut || submitting) return;
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a")) return;
      const key = event.key.toLowerCase();
      const index = key >= "1" && key <= "9"
        ? Number(key) - 1
        : key >= "a" && key <= "z"
          ? key.charCodeAt(0) - 97
          : -1;
      const option = quest.choices[index];
      if (!option) return;
      event.preventDefault();
      setChoice(option.id);
      setOperationMessage(`${option.label} selected. Activate Lock answer to submit.`);
      setOperationTone("info");
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [quest, submitting, timedOut]);

  const userRank = useMemo(() => {
    const above = leaderboard.filter((player) => player.points > points).length;
    return above + 1;
  }, [points]);

  async function advanceReplay() {
    if (!quest || !choice || submitting) return;
    setSubmitting(true);
    setOperationMessage("Locking answer and verifying the next match event…");
    setOperationTone("info");
    let settledLocallyAfterFailure = false;
    if (apiSessionId && apiSessionToken) {
      try {
        const response = await fetch(`${API_BASE}/v1/rooms/${apiSessionId}/answers`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiSessionToken}` },
          body: JSON.stringify({ questId: quest.id, choiceId: choice }),
        });
        if (!response.ok) {
          const problem = await response.json().catch(() => ({ error: "request_rejected" })) as { error?: string };
          if (response.status === 401 || response.status === 404) {
            setApiAvailable(false);
            setSourceConnected(false);
            setApiSessionId(null);
            setApiSessionToken(null);
          }
          setOperationMessage(problem.error === "answer_window_closed"
            ? "The server answer window is closed. Restart the window before submitting."
            : "The server rejected this answer. Refresh the room state and try again.");
          setOperationTone("warning");
          setSubmitting(false);
          return;
        }
        const payload = await response.json() as { room: ApiRoom; settlement: { questId: string; choiceId: string; correct: boolean; points: number } };
        const settlement = { questId: payload.settlement.questId, choice: payload.settlement.choiceId, correct: payload.settlement.correct, points: payload.settlement.points };
        setEventIndex(payload.room.eventIndex);
        setPoints(payload.room.session.points);
        setStreak(payload.room.session.streak);
        setAnswers(payload.room.answers.map((answer) => ({ questId: answer.questId, choice: answer.choiceId, correct: answer.correct, points: answer.points })));
        setLastResult(settlement);
        setSourceConnected(payload.room.source.connected);
        setChoice(null);
        setSeconds(secondsUntil(payload.room.questClosesAt));
        setOperationMessage(settlement.correct ? `Answer settled correctly. ${settlement.points} points added.` : "Answer settled. No points added this round.");
        setOperationTone("success");
        setSubmitting(false);
        return;
      } catch {
        setApiAvailable(false);
        setSourceConnected(false);
        setApiSessionId(null);
        setApiSessionToken(null);
        settledLocallyAfterFailure = true;
      }
    }
    const correct = choice === quest.correctChoice;
    const settlement = {
      questId: quest.id,
      choice,
      correct,
      points: correct ? quest.points : 0,
    };

    setAnswers((current) => [...current, settlement]);
    setLastResult(settlement);
    setPoints((current) => current + settlement.points);
    setStreak((current) => (correct ? current + 1 : 0));
    setEventIndex((current) => Math.min(current + 1, events.length - 1));
    setChoice(null);
    setSeconds(LOCAL_ANSWER_WINDOW_SECONDS);
    setOperationMessage(settledLocallyAfterFailure
      ? "Replay service was interrupted. This result was settled from the bundled deterministic fixture."
      : correct
        ? `Answer settled correctly. ${settlement.points} points added.`
        : "Answer settled. No points added this round.");
    setOperationTone(settledLocallyAfterFailure ? "warning" : "success");
    setSubmitting(false);
  }

  async function resetReplay() {
    let nextSeconds = LOCAL_ANSWER_WINDOW_SECONDS;
    if (apiSessionId && apiSessionToken) {
      try {
        const response = await fetch(`${API_BASE}/v1/rooms/${apiSessionId}/reset`, { method: "POST", headers: { authorization: `Bearer ${apiSessionToken}` } });
        if (!response.ok) throw new Error(`reset request failed: ${response.status}`);
        const room = await response.json() as ApiRoom;
        nextSeconds = secondsUntil(room.questClosesAt);
      } catch {
        setApiAvailable(false);
        setSourceConnected(false);
        setApiSessionId(null);
        setApiSessionToken(null);
      }
    }
    setEventIndex(0);
    setChoice(null);
    setSeconds(nextSeconds);
    setPoints(860);
    setStreak(3);
    setAnswers([]);
    setLastResult(null);
    setView("room");
    setSubmitting(false);
    setOperationMessage(apiAvailable ? "Replay reset. Server adapter ready." : "Replay reset in local deterministic mode.");
    setOperationTone(apiAvailable ? "info" : "warning");
  }

  function focusQuest() {
    const questElement = document.getElementById("active-quest");
    if (!questElement) return;
    const top = window.scrollY + questElement.getBoundingClientRect().top - 14;
    window.scrollTo({ top, behavior: "smooth" });
  }

  function handlePrimaryAction() {
    if (timedOut) {
      void restartAnswerWindow();
      return;
    }
    if (choice) {
      void advanceReplay();
      return;
    }
    focusQuest();
    setOperationMessage("Choose an answer, then lock it before the timer expires.");
    setOperationTone("info");
  }

  async function restartAnswerWindow() {
    if (apiSessionId && apiSessionToken) {
      try {
        const response = await fetch(`${API_BASE}/v1/rooms/${apiSessionId}/window`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiSessionToken}` },
        });
        if (!response.ok) throw new Error(`window request failed: ${response.status}`);
        const room = await response.json() as ApiRoom;
        setSeconds(secondsUntil(room.questClosesAt));
        setOperationMessage("Answer window restarted by the server. Choose one option before time expires.");
        setOperationTone("info");
        return;
      } catch {
        setApiAvailable(false);
        setSourceConnected(false);
        setApiSessionId(null);
        setApiSessionToken(null);
      }
    }
    setSeconds(LOCAL_ANSWER_WINDOW_SECONDS);
    setOperationMessage("Server window unavailable. Continuing with a local deterministic answer window.");
    setOperationTone("warning");
  }

  function handleChoiceKeyDown(index: number, keyboardEvent: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!quest || submitting || timedOut) return;
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(keyboardEvent.key)) return;
    keyboardEvent.preventDefault();
    const lastIndex = quest.choices.length - 1;
    const nextIndex = keyboardEvent.key === "Home"
      ? 0
      : keyboardEvent.key === "End"
        ? lastIndex
        : keyboardEvent.key === "ArrowRight" || keyboardEvent.key === "ArrowDown"
          ? (index + 1) % quest.choices.length
          : (index - 1 + quest.choices.length) % quest.choices.length;
    const nextChoice = quest.choices[nextIndex];
    setChoice(nextChoice.id);
    setOperationMessage(`${nextChoice.label} selected. Activate Lock answer to submit.`);
    setOperationTone("info");
    const choices = keyboardEvent.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='radio']");
    choices?.[nextIndex]?.focus();
  }

  const primaryActionLabel = timedOut
    ? "Restart answer window"
    : submitting
      ? "Verifying result…"
      : choice
        ? "Lock answer & reveal"
        : "Choose an answer";

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <a className="brand" href="#top" aria-label="CrowdQuest home">
          <BrandLogo />
        </a>

        <div className={`topbar-status source-${sourceState}`}>
          <span className="status-pulse" aria-hidden="true" />
          <span>{sourceCopy.label}</span>
          <span className="status-divider" />
          <span>Fixture {match.id}</span>
        </div>

        <div className="topbar-actions">
          <Button variant="panel" size="icon" className="icon-button" aria-label="Open TxLINE signal monitor" onClick={() => setView("signal")}>
            <Icon name="radio" />
          </Button>
          <Button variant="panel" size="icon" className="icon-button" aria-label="How CrowdQuest works" onClick={() => setView("trace")}>
            <Icon name="info" />
          </Button>
          <div className="profile-button">
            <span>AB</span>
            <span className="profile-copy"><b>Guest fan</b><small>{points.toLocaleString()} pts</small></span>
          </div>
        </div>
      </header>

      <nav className="mode-switch" aria-label="Workspace view">
        <button className={view === "room" ? "active" : ""} onClick={() => setView("room")}>
          <Icon name="play" /> Match room
        </button>
        <button className={view === "trace" ? "active" : ""} onClick={() => setView("trace")}>
          <Icon name="shield" /> Receipts & controls
        </button>
        <button className={view === "signal" ? "active" : ""} onClick={() => setView("signal")}>
          <Icon name="radio" /> Signal monitor
        </button>
      </nav>

      {view === "room" ? (
        <div className="workspace" id="top">
          <aside className="left-rail" aria-label="Replay and match context">
            <section className="panel compact-panel replay-panel">
              <div className="eyebrow-row">
                <span className="eyebrow"><Icon name="radio" /> Demo replay</span>
                <span>{eventIndex + 1}/{events.length}</span>
              </div>
              <Progress value={(eventIndex / (events.length - 1)) * 100} className="replay-progress" aria-label={`Replay progress ${eventIndex + 1} of ${events.length}`} />
              <p>Walk judges through a real completed fixture even when no match is live.</p>
              <button className="text-button" onClick={resetReplay}>Restart replay <Icon name="refresh" /></button>
            </section>

            <section className="panel compact-panel">
              <div className="panel-title-row">
                <h2>Match pulse</h2>
                <Badge variant="neutral">normalized</Badge>
              </div>
              <div className="probability-card">
                <div>
                  <span>France win signal</span>
                  <strong>{event.marketHome}%</strong>
                </div>
                <div className="probability-bar"><span style={{ width: `${event.marketHome}%` }} /></div>
                <small>StablePrice direction · display-only</small>
              </div>
              <div className="stat-grid">
                <div><span>Quests</span><b>{answers.length}/{quests.length}</b></div>
                <div><span>Streak</span><b>{streak}×</b></div>
                <div><span>Rank</span><b>#{userRank}</b></div>
                <div><span>Pool</span><b>${match.sponsorPool}</b></div>
              </div>
            </section>

            <section className="panel compact-panel sponsor-card">
              <div className="sponsor-icon"><Icon name="users" /></div>
              <div>
                <h3>Run a club room</h3>
                <p>Sponsor free quests for your community. No fan stake required.</p>
              </div>
              <a
                href={POLAR_CHECKOUT_URL || "#business-model"}
                rel={POLAR_CHECKOUT_URL ? "noreferrer" : undefined}
                target={POLAR_CHECKOUT_URL ? "_blank" : undefined}
              >
                {POLAR_CHECKOUT_URL ? "Start with Polar" : "See the model"} <Icon name="arrow" />
              </a>
            </section>
          </aside>

          <section className="match-column" aria-label="Active match and quest">
            <section className={`source-banner source-${sourceState}`} aria-labelledby="source-title">
              <span className="source-banner-icon"><Icon name={sourceState === "live" ? "radio" : sourceState === "local" ? "info" : "shield"} /></span>
              <div>
                <span className="source-label">{sourceCopy.label}</span>
                <b id="source-title">{sourceCopy.title}</b>
                <small>{sourceCopy.detail}</small>
              </div>
              <Badge variant={sourceState === "live" ? "live" : sourceState === "replay" ? "replay" : sourceState === "local" ? "offline" : "neutral"}>
                {sourceState}
              </Badge>
            </section>

            <div className={`operation-notice tone-${operationTone}`} role="status" aria-live="polite">
              <Icon name={operationTone === "success" ? "circle-check" : operationTone === "warning" ? "info" : "radio"} />
              <span>{operationMessage}</span>
            </div>

            <section className="match-hero panel">
              <div className="stadium-lines" />
              <div className="match-meta">
                <span>{match.competition}</span>
                <span className="dot-separator" aria-hidden="true" />
                <span>{match.startedAt}</span>
              </div>
              <div className="scoreboard">
                <div className="team team-home">
                  <span className="flag"><Image alt="France flag" height={28} src={`/flags/${match.home.flagCode}.svg`} width={28} /></span>
                  <div><b>{match.home.name}</b><small>{match.home.code}</small></div>
                </div>
                <div className="score-block">
                  <div className="score"><strong>{event.homeScore}</strong><span>—</span><strong>{event.awayScore}</strong></div>
                  <span className={`minute-pill ${finished ? "finished" : ""}`}>{event.minuteLabel}</span>
                </div>
                <div className="team team-away">
                  <div><b>{match.away.name}</b><small>{match.away.code}</small></div>
                  <span className="flag"><Image alt="Morocco flag" height={28} src={`/flags/${match.away.flagCode}.svg`} width={28} /></span>
                </div>
              </div>
              <div className={`event-strip ${EVENT_COLORS[event.kind]}`}>
                <span className="event-icon"><Icon name={event.kind === "goal" ? "goal" : event.kind === "chance" ? "target" : event.kind === "final" ? "circle-check" : "clock"} /></span>
                <div><b>{event.title}</b><span>{event.detail}</span></div>
                <span className="event-time">{event.minuteLabel}</span>
              </div>
            </section>

            {!finished && quest ? (
              <section className="quest-card panel" id="active-quest" aria-labelledby="quest-title">
                {lastResult && (
                  <div className={`settlement-banner ${lastResult.correct ? "won" : "missed"}`}>
                    <span><Icon name={lastResult.correct ? "check" : "info"} /></span>
                    <div>
                      <b>{lastResult.correct ? `Correct · +${lastResult.points} points` : "Settled · not this time"}</b>
                      <small>Previous quest closed from the next configured fixture event.</small>
                    </div>
                    <span className="proof-chip">receipt saved</span>
                  </div>
                )}

                <div className="quest-heading">
                  <div>
                    <span className="eyebrow"><Icon name="spark" /> Host quest · #{eventIndex + 1}</span>
                    <h1 id="quest-title">{quest.prompt}</h1>
                    <p>{quest.context}</p>
                    <span className="answer-help">Keyboard: press {quest.choices.map((_, index) => String.fromCharCode(65 + index)).join(", ")} or 1–{quest.choices.length}. You can change your choice until you lock it.</span>
                  </div>
                  <div className={`countdown ${seconds < 8 ? "urgent" : ""} ${submitting ? "submitting" : ""}`}>
                    <span>{submitting ? "VERIFYING" : timedOut ? "CLOSED" : "LOCKS"}</span>
                    <strong>{submitting ? <Icon name="refresh" /> : `0:${seconds.toString().padStart(2, "0")}`}</strong>
                  </div>
                </div>

                <div className="choice-grid" role="radiogroup" aria-label="Quest answer choices">
                  {quest.choices.map((option, index) => (
                    <button
                      className={`choice-card ${choice === option.id ? "selected" : ""}`}
                      disabled={seconds === 0 || submitting}
                      key={option.id}
                      onClick={() => {
                        setChoice(option.id);
                        setOperationMessage(`${option.label} selected. Activate Lock answer to submit.`);
                        setOperationTone("info");
                      }}
                      onKeyDown={(keyboardEvent) => handleChoiceKeyDown(index, keyboardEvent)}
                      role="radio"
                      aria-checked={choice === option.id}
                      tabIndex={choice === option.id || (!choice && index === 0) ? 0 : -1}
                      type="button"
                    >
                      <span className="choice-key">{String.fromCharCode(65 + index)}</span>
                      <span><b>{option.label}</b><small>{option.hint}</small></span>
                      <span className="choice-check"><Icon name="check" /></span>
                    </button>
                  ))}
                </div>

                <div className="quest-footer">
                  <div className="reward-copy">
                    <span className="reward-icon"><Icon name="trophy" /></span>
                    <div><b>+{quest.points} points</b><small>Sponsor reward leaderboard</small></div>
                  </div>
                  <div className="settles-copy"><Icon name="shield" /><span>Settles from<br/><b>{quest.settlesOn}</b></span></div>
                  <Button
                    className="primary-button"
                    disabled={submitting}
                    onClick={handlePrimaryAction}
                  >
                    {primaryActionLabel} <Icon name={timedOut || submitting ? "refresh" : "arrow"} />
                  </Button>
                </div>
              </section>
            ) : (
              <section className="finish-card panel">
                {lastResult && (
                  <div className={`final-settlement ${lastResult.correct ? "won" : "missed"}`}>
                    <Icon name={lastResult.correct ? "circle-check" : "info"} />
                    <span><b>Final quest settled</b><small>{lastResult.correct ? `+${lastResult.points} points recorded` : "No points added for the final quest"}</small></span>
                  </div>
                )}
                <span className="finish-burst"><Icon name="trophy" /></span>
                <span className="eyebrow">Replay complete</span>
                <h1>{points.toLocaleString()} points</h1>
                <p>You completed {answers.length} replay quests with a {streak}× finishing streak. Every submitted answer has a session settlement record.</p>
                <div className="finish-actions">
                  <Button className="primary-button" onClick={() => setView("trace")}>Inspect receipts <Icon name="shield" /></Button>
                  <Button variant="panel" className="secondary-button" onClick={resetReplay}>Play again</Button>
                </div>
              </section>
            )}

            <p className="demo-disclosure">Replay mode demonstrates the live product loop using a completed covered fixture. Production mode consumes the TxLINE snapshot and SSE endpoints server-side.</p>
          </section>

          <aside className="right-rail" aria-label="Leaderboard and workflow status">
            <section className="panel leaderboard-panel">
              <div className="panel-title-row">
                <div><span className="eyebrow">Match room</span><h2>Leaderboard</h2></div>
                <span className="people-live"><span /> demo board · 248</span>
              </div>
              <div className="podium-row">
                {leaderboard.slice(0, 3).map((player) => (
                  <div className={`podium podium-${player.rank}`} key={player.name}>
                    <span className="avatar">{player.avatar}</span>
                    <b>{player.name}</b>
                    <small>{player.points.toLocaleString()}</small>
                    <span className="rank-badge">{player.rank}</span>
                  </div>
                ))}
              </div>
              <div className="ranking-list">
                <div className="ranking-row you-row">
                  <span className="row-rank">{userRank}</span><span className="avatar small">AB</span>
                  <span className="player-name"><b>You</b><small>{streak}× streak</small></span><strong>{points.toLocaleString()}</strong>
                </div>
                {leaderboard.slice(3).map((player) => (
                  <div className="ranking-row" key={player.name}>
                    <span className="row-rank">{player.rank}</span><span className="avatar small">{player.avatar}</span>
                    <span className="player-name"><b>{player.name}</b><small>{player.streak}× streak</small></span><strong>{player.points.toLocaleString()}</strong>
                  </div>
                ))}
              </div>
              <div className="pool-note">
                <Icon name="wallet" />
                <div><b>$20 USDC demo sponsor pool</b><small>Top 3 become eligible after settlement; any test payout still requires approval</small></div>
              </div>
            </section>

            <section className="panel compact-panel activity-panel">
              <div className="panel-title-row"><h2>Workflow status</h2><button onClick={() => setView("trace")}>View system map</button></div>
              <div className="activity-item"><span className="activity-dot lime"/><div><b>Quest #{Math.min(eventIndex + 1, quests.length)} available</b><small>Deterministic rule selected for this replay phase</small></div><time>now</time></div>
              <div className="activity-item"><span className="activity-dot violet"/><div><b>{sourceState === "local" ? "Local fixture loaded" : "Adapter state normalized"}</b><small>{sourceState === "local" ? "No provider connection is being claimed" : "Raw provider payload stays server-side"}</small></div><time>ready</time></div>
              <div className="activity-item"><span className="activity-dot amber"/><div><b>Payout policy configured</b><small>Test mode · approval required</small></div><time>guarded</time></div>
            </section>
          </aside>

          <nav className="mobile-action-dock" aria-label="Quest actions">
            <button className="dock-nav-button" type="button" onClick={() => setView("trace")}>
              <Icon name="shield" />
              <span>Receipts</span>
            </button>
            {!finished && quest ? (
              <Button className="dock-primary-button" disabled={submitting} onClick={handlePrimaryAction}>
                <span>{primaryActionLabel}</span>
                <Icon name={timedOut || submitting ? "refresh" : "arrow"} />
              </Button>
            ) : (
              <Button className="dock-primary-button" onClick={resetReplay}>
                <span>Play replay again</span><Icon name="refresh" />
              </Button>
            )}
          </nav>
        </div>
      ) : view === "signal" ? (
        <SignalMonitor onBack={() => setView("room")} />
      ) : (
        <TraceView onBack={() => setView("room")} answers={answers} sourceState={sourceState} />
      )}

      <footer className="product-footer" id="business-model">
        <span>CrowdQuest · Built for the TxODDS World Cup Hackathon</span>
        <a href="/design-system">Design system <Icon name="external" /></a>
        <span>Free-to-play · sponsor-funded · human-owned submission</span>
      </footer>
    </main>
  );
}

function secondsUntil(isoTime: string | null) {
  if (!isoTime) return LOCAL_ANSWER_WINDOW_SECONDS;
  return Math.max(0, Math.ceil((Date.parse(isoTime) - Date.now()) / 1_000));
}

type SourceTelemetry = {
  provider: string;
  connected: boolean;
  mode: "live" | "replay";
  fixtureId: number;
  lastCheckedAt: string;
  endpoints: string[];
  normalizedEvents: number;
  authoritativeQuests: number;
  streaming: boolean;
};

type TelemetrySample = {
  at: number;
  normalizedEvents: number;
  latency: number;
};

function SignalMonitor({ onBack }: { onBack: () => void }) {
  const [source, setSource] = useState<SourceTelemetry | null>(null);
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [requestError, setRequestError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function sampleSource() {
      const startedAt = performance.now();
      try {
        const response = await fetch(`${API_BASE}/v1/source`, { cache: "no-store" });
        if (!response.ok) throw new Error(`source request failed: ${response.status}`);
        const payload = await response.json() as SourceTelemetry;
        if (cancelled) return;
        const sample = {
          at: Date.now(),
          normalizedEvents: payload.normalizedEvents,
          latency: Math.max(1, Math.round(performance.now() - startedAt)),
        };
        setSource(payload);
        setSamples((current) => [...current, sample].slice(-24));
        setRequestError(false);
      } catch {
        if (!cancelled) setRequestError(true);
      }
    }
    void sampleSource();
    const timer = window.setInterval(() => void sampleSource(), 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const latest = samples.at(-1);
  const graphPoints = samples.length > 1
    ? samples.map((sample, index) => {
      const x = (index / (samples.length - 1)) * 100;
      const maxEvents = Math.max(1, ...samples.map((item) => item.normalizedEvents));
      const y = 94 - (sample.normalizedEvents / maxEvents) * 78;
      return `${x},${y}`;
    }).join(" ")
    : "0,94 100,94";
  const mode = requestError ? "offline" : source?.connected ? "live" : source ? "replay" : "checking";

  return (
    <section className="signal-page" aria-labelledby="signal-title">
      <header className="signal-header">
        <div>
          <span className="eyebrow"><Icon name="radio" /> TxLINE source observatory</span>
          <h1 id="signal-title">Signal monitor.<br/><em>Evidence, not theatre.</em></h1>
          <p>Client-observed telemetry from CrowdQuest’s public source boundary. Replay stays labelled replay; a live badge appears only after accepted TxLINE fixture evidence resolves a quest.</p>
        </div>
        <Button variant="panel" className="secondary-button" onClick={onBack}><Icon name="arrow-left" /> Back to match room</Button>
      </header>

      <section className={`signal-status panel signal-${mode}`}>
        <div className="signal-beacon"><span /><span /><Icon name="radio" /></div>
        <div>
          <span className="source-label">Current source state</span>
          <h2>{mode === "live" ? "TxLINE devnet · accepted live evidence" : mode === "replay" ? "Devnet adapter · replay telemetry" : mode === "offline" ? "Source endpoint unavailable" : "Checking the source boundary"}</h2>
          <p>{source?.connected
            ? "Normalized fixture events are authoritative for quest settlement."
            : source
              ? "The transport worker may be open, but no normalized TxLINE evidence is currently authoritative."
              : "Waiting for the first public source sample."}</p>
        </div>
        <Badge variant={mode === "live" ? "live" : mode === "replay" ? "replay" : "offline"}>{mode}</Badge>
      </section>

      <div className="telemetry-grid">
        <section className="panel telemetry-chart">
          <div className="panel-title-row">
            <div><span className="eyebrow">Rolling source samples</span><h2>Normalized event count</h2></div>
            <span className="sample-clock">4s cadence · {samples.length}/24</span>
          </div>
          <div className="chart-stage" aria-label={`Normalized TxLINE events: ${source?.normalizedEvents ?? 0}`}>
            <span className="chart-axis axis-top">{Math.max(1, ...samples.map((sample) => sample.normalizedEvents))}</span>
            <span className="chart-axis axis-bottom">0</span>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Rolling normalized event count graph">
              <defs><linearGradient id="signal-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--signal)" stopOpacity=".24"/><stop offset="1" stopColor="var(--signal)" stopOpacity="0"/></linearGradient></defs>
              <polygon points={`0,100 ${graphPoints} 100,100`} fill="url(#signal-fill)" />
              <polyline points={graphPoints} fill="none" stroke="var(--signal)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
            </svg>
            {!source?.normalizedEvents && <div className="flatline-note"><Icon name="info" /> Zero accepted events is the current truthful value—not missing chart data.</div>}
          </div>
          <div className="chart-legend"><span><i className="legend-signal" /> accepted normalized events</span><span>latest sample {latest ? new Date(latest.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "pending"}</span></div>
        </section>

        <section className="metric-stack">
          <article className="panel signal-metric"><span>Adapter mode</span><strong>{source?.mode ?? "—"}</strong><small>Provider: {source?.provider ?? "checking"}</small></article>
          <article className="panel signal-metric"><span>Normalized events</span><strong>{source?.normalizedEvents ?? 0}</strong><small>{source?.authoritativeQuests ?? 0} authoritative quests</small></article>
          <article className="panel signal-metric"><span>Source endpoint RTT</span><strong>{latest ? `${latest.latency} ms` : "—"}</strong><small>Measured in this browser</small></article>
          <article className="panel signal-metric"><span>Stream worker</span><strong>{source?.streaming ? "open" : "idle"}</strong><small>{source?.connected ? "accepted evidence" : "not authoritative"}</small></article>
        </section>
      </div>

      <div className="signal-lower-grid">
        <section className="panel pipeline-panel">
          <div className="panel-title-row"><div><span className="eyebrow">Resolution path</span><h2>From feed to fan result</h2></div><Badge variant="neutral">server-side</Badge></div>
          <div className="signal-pipeline">
            {["TxLINE SSE", "Normalize event", "Derive match fact", "Resolve quest", "Update fan room"].map((step, index) => (
              <div key={step}><span>0{index + 1}</span><Icon name={index === 0 ? "radio" : index === 1 ? "database" : index === 2 ? "layers" : index === 3 ? "shield" : "circle-check"}/><b>{step}</b>{index < 4 && <i><Icon name="arrow" /></i>}</div>
            ))}
          </div>
        </section>

        <section className="panel endpoint-panel">
          <div className="panel-title-row"><div><span className="eyebrow">Configured boundary</span><h2>Fixture-scoped routes</h2></div><code>#{source?.fixtureId ?? match.id}</code></div>
          <div className="endpoint-list">
            {(source?.endpoints ?? ["/api/fixtures/snapshot", `/api/scores/historical/${match.id}`, `/api/odds/snapshot/${match.id}`, "/api/scores/stream"]).map((endpoint) => (
              <div key={endpoint}><span className="endpoint-dot"/><code>{endpoint}</code><span>{endpoint.includes("stream") ? "SSE" : "GET"}</span></div>
            ))}
          </div>
          <p className="source-timestamp">Provider check: {source?.lastCheckedAt ? new Date(source.lastCheckedAt).toLocaleString() : "pending"}</p>
        </section>
      </div>

      <section className="panel replay-timeline-panel">
        <div className="panel-title-row"><div><span className="eyebrow">Judgeable fallback</span><h2>Deterministic fixture timeline</h2></div><Badge variant="replay">historical replay</Badge></div>
        <div className="replay-timeline">
          {events.map((item) => <div key={item.id} className={`timeline-event timeline-${item.kind}`}><span>{item.minuteLabel}</span><i/><b>{item.homeScore}—{item.awayScore}</b><small>{item.title}</small></div>)}
        </div>
        <p>This lower timeline is authored replay evidence and is intentionally separated from the live telemetry graph above.</p>
      </section>
    </section>
  );
}

function TraceView({
  onBack,
  answers,
  sourceState,
}: {
  onBack: () => void;
  answers: SettledAnswer[];
  sourceState: SourceState;
}) {
  const trace = toolTrace.map((tool, index) => index === 0
    ? { ...tool, state: sourceState === "live" ? "live connected" : sourceState === "replay" ? "replay adapter" : sourceState === "connecting" ? "checking source" : "local replay" }
    : tool);

  return (
    <section className="trace-page">
      <div className="trace-intro">
        <span className="eyebrow"><Icon name="shield" /> System map</span>
        <h1>One fan experience.<br/><em>Four guarded capabilities.</em></h1>
        <p>CrowdQuest is a vertical test of the AI operating-system idea: fans never learn feed APIs, bounty infrastructure, wallets, or payment workflows. They play; the workspace routes the work.</p>
        <Button variant="panel" className="secondary-button" onClick={onBack}><Icon name="arrow-left" /> Back to match room</Button>
      </div>

      <div className="trace-grid">
        {trace.map((tool, index) => (
          <article className="trace-card panel" key={tool.name}>
            <span className="trace-number">0{index + 1}</span>
            <span className={`trace-state state-${tool.state.replace(" ", "-")}`}>{tool.state}</span>
            <h2>{tool.name}</h2>
            <b>{tool.role}</b>
            <p>{tool.detail}</p>
            {index < toolTrace.length - 1 && <span className="trace-connector"><Icon name="arrow" /></span>}
          </article>
        ))}
      </div>

      <div className="proof-layout">
        <section className="panel proof-panel">
          <div className="panel-title-row"><div><span className="eyebrow">Session record</span><h2>Replay settlement receipts</h2></div><Badge variant="replay">session-local</Badge></div>
          <div className="receipt-list">
            <div className="receipt-row"><span className="receipt-icon feed">TX</span><div><b>Fixture loaded</b><small>fixtures/snapshot · fixture {match.id}</small></div><code>{sourceState === "live" ? "live_source" : sourceState === "replay" ? "adapter_replay" : sourceState === "connecting" ? "source_check" : "local_fixture"}</code></div>
            {answers.length ? answers.map((answer, index) => (
              <div className="receipt-row" key={answer.questId}>
                <span className={`receipt-icon ${answer.correct ? "pass" : "fail"}`}><Icon name={answer.correct ? "check" : "minus"} /></span>
                <div><b>Quest #{index + 1} settled</b><small>Choice sealed before the next event</small></div>
                <code>{answer.correct ? `+${answer.points}_points` : "settled"}</code>
              </div>
            )) : <div className="empty-receipt">Complete a quest to add its settlement receipt.</div>}
          </div>
        </section>

        <section className="panel guardrail-panel">
          <span className="eyebrow">Security policy</span>
          <h2>Agents propose. Policies decide.</h2>
          <div className="guardrail"><Icon name="check"/><span><b>Read actions</b><small>TxLINE access is server-side and scoped.</small></span></div>
          <div className="guardrail"><Icon name="check"/><span><b>Quest actions</b><small>Only deterministic templates may publish automatically.</small></span></div>
          <div className="guardrail"><Icon name="check"/><span><b>Money actions</b><small>Testnet by default; real payouts require limits and approval.</small></span></div>
          <div className="guardrail"><Icon name="check"/><span><b>Data handling</b><small>The public API returns normalized product state, not raw feeds.</small></span></div>
        </section>
      </div>

      <section className="business-strip panel">
        <div><span className="eyebrow">Commercial path</span><h2>Fan clubs and sponsors fund the fun.</h2></div>
        <p>Free public rooms drive reach. Polar powers paid private leagues and sponsor campaigns; optional USDC rewards create measurable activation without asking fans to wager.</p>
        <div className="business-metrics"><span><b>₹0</b><small>fan entry fee</small></span><span><b>2.5%</b><small>campaign fee</small></span><span><b>104</b><small>match inventory</small></span></div>
      </section>
    </section>
  );
}
