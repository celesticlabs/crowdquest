import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import pg from "pg";
import type { CreatedRoom, RoomState } from "./domain.js";

export interface RoomStore {
  create(displayName: string): Promise<CreatedRoom>;
  get(id: string): Promise<RoomState | null>;
  save(state: RoomState, expectedVersion: number): Promise<boolean>;
  purgeExpired(): Promise<number>;
  health(): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, RoomState>();

  constructor(private readonly ttlMs: number, private readonly answerWindowMs: number) {}

  async create(displayName: string) {
    const created = newRoom(displayName, this.ttlMs, this.answerWindowMs);
    this.rooms.set(created.state.id, structuredClone(created.state));
    return structuredClone(created);
  }

  async get(id: string) {
    const state = this.rooms.get(id);
    if (!state) return null;
    if (Date.parse(state.expiresAt) <= Date.now()) {
      this.rooms.delete(id);
      return null;
    }
    return structuredClone(state);
  }

  async save(state: RoomState, expectedVersion: number) {
    const current = this.rooms.get(state.id);
    if (!current || current.version !== expectedVersion || Date.parse(current.expiresAt) <= Date.now()) return false;
    this.rooms.set(state.id, structuredClone(state));
    return true;
  }

  async purgeExpired() {
    let deleted = 0;
    for (const [id, state] of this.rooms) {
      if (Date.parse(state.expiresAt) <= Date.now()) {
        this.rooms.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async health() { return true; }
  async close() { this.rooms.clear(); }
}

export class PostgresRoomStore implements RoomStore {
  private pool: pg.Pool;

  private constructor(connectionString: string, private readonly ttlMs: number, private readonly answerWindowMs: number) {
    this.pool = new pg.Pool({ connectionString, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  }

  static async connect(connectionString: string, ttlMs: number, answerWindowMs: number) {
    const store = new PostgresRoomStore(connectionString, ttlMs, answerWindowMs);
    await store.pool.query(`CREATE TABLE IF NOT EXISTS crowdquest_room_sessions (
      id uuid PRIMARY KEY,
      display_name text NOT NULL,
      access_token_hash text,
      state jsonb NOT NULL,
      version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz
    )`);
    await store.pool.query("ALTER TABLE crowdquest_room_sessions ADD COLUMN IF NOT EXISTS access_token_hash text");
    await store.pool.query("ALTER TABLE crowdquest_room_sessions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0");
    await store.pool.query("ALTER TABLE crowdquest_room_sessions ADD COLUMN IF NOT EXISTS expires_at timestamptz");
    await store.pool.query("CREATE INDEX IF NOT EXISTS crowdquest_room_sessions_expires_at_idx ON crowdquest_room_sessions (expires_at)");
    await store.purgeExpired();
    return store;
  }

  async create(displayName: string) {
    const created = newRoom(displayName, this.ttlMs, this.answerWindowMs);
    const state = created.state;
    await this.pool.query(
      `INSERT INTO crowdquest_room_sessions
       (id, display_name, access_token_hash, state, version, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [state.id, state.displayName, state.accessTokenHash, JSON.stringify(state), state.version, state.createdAt, state.updatedAt, state.expiresAt],
    );
    return created;
  }

  async get(id: string) {
    const result = await this.pool.query<{ state: RoomState }>(
      `SELECT state FROM crowdquest_room_sessions
       WHERE id = $1 AND expires_at > now() AND access_token_hash IS NOT NULL`,
      [id],
    );
    return result.rows[0]?.state ?? null;
  }

  async save(state: RoomState, expectedVersion: number) {
    const result = await this.pool.query(
      `UPDATE crowdquest_room_sessions
       SET display_name = $2, access_token_hash = $3, state = $4::jsonb,
           version = $5, updated_at = $6, expires_at = $7
       WHERE id = $1 AND version = $8 AND expires_at > now()`,
      [state.id, state.displayName, state.accessTokenHash, JSON.stringify(state), state.version, state.updatedAt, state.expiresAt, expectedVersion],
    );
    return result.rowCount === 1;
  }

  async purgeExpired() {
    const result = await this.pool.query(
      "DELETE FROM crowdquest_room_sessions WHERE expires_at IS NULL OR expires_at <= now() OR access_token_hash IS NULL",
    );
    return result.rowCount ?? 0;
  }

  async health() {
    const result = await this.pool.query<{ ok: number }>("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  }

  async close() { await this.pool.end(); }
}

export async function createStore(databaseUrl: string | undefined, ttlMs: number, answerWindowMs: number): Promise<RoomStore> {
  return databaseUrl ? PostgresRoomStore.connect(databaseUrl, ttlMs, answerWindowMs) : new MemoryRoomStore(ttlMs, answerWindowMs);
}

export function verifyRoomToken(state: RoomState, token: string) {
  const supplied = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(state.accessTokenHash, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function newRoom(displayName: string, ttlMs: number, answerWindowMs: number): CreatedRoom {
  const now = new Date();
  const accessToken = randomBytes(32).toString("base64url");
  const state: RoomState = {
    id: randomUUID(),
    accessTokenHash: hashToken(accessToken),
    displayName,
    eventIndex: 0,
    points: 860,
    streak: 3,
    answers: [],
    questClosesAt: new Date(now.getTime() + answerWindowMs).toISOString(),
    version: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  return { state, accessToken };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
