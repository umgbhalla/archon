/**
 * Daemon state persistence (ADR-0011, JSON-files variant).
 *
 * The task accepts the codex-workflows-style split: a roster.json index plus a
 * per-session directory holding meta.json + transcript.log. This is simpler than
 * SQLite and good enough for the session-grid surface; the relational store
 * (ADR-0011 leaning) can replace this behind the same Persistence interface.
 *
 * Layout under <configDir>/daemon/:
 *   roster.json                  { sessions: [ { id, agent, ... } ] }   (the index)
 *   sessions/<id>/meta.json      full SessionSnapshot + create options needed to recover
 *   sessions/<id>/transcript.log accumulated assistant text (append-only)
 *
 * All writes are best-effort and atomic-ish (write tmp, rename) so a crash mid-write
 * never corrupts the roster. Reads tolerate missing/garbage files.
 */
import { join } from "node:path";
import { mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import type { SessionSnapshot } from "../core/session-manager.ts";
import type { CreateSessionParams } from "./protocol.ts";

/** What we persist per session: the snapshot plus enough to recreate the backend. */
export interface PersistedSession {
  snapshot: SessionSnapshot;
  /** The options used to create the session (so a restart can respawn the backend). */
  createOptions: CreateSessionParams;
}

export interface Roster {
  version: number;
  sessions: PersistedSession[];
}

export interface Persistence {
  /** Upsert a session's metadata (snapshot + create options). */
  saveSession(rec: PersistedSession): Promise<void>;
  /** Append assistant transcript text for a session. */
  appendTranscript(id: string, text: string): Promise<void>;
  /** Read the accumulated transcript for a session ("" if none). */
  readTranscript(id: string): Promise<string>;
  /** Remove a session's persisted metadata + transcript. */
  removeSession(id: string): Promise<void>;
  /** Load the full roster (for daemon restart recovery). */
  loadRoster(): Promise<PersistedSession[]>;
  /** Wait for all pending writes to land on disk. */
  flush(): Promise<void>;
}

const ROSTER_VERSION = 1;

/** Filesystem-backed persistence rooted at <configDir>/daemon. */
export class FilePersistence implements Persistence {
  private rosterPath: string;
  private sessionsDir: string;
  /** In-memory roster mirror, kept in sync so saveSession is a single write. */
  private roster = new Map<string, PersistedSession>();
  private loaded = false;
  /** Serializes all mutating writes so concurrent saves never clobber the roster. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {
    this.rosterPath = join(root, "roster.json");
    this.sessionsDir = join(root, "sessions");
  }

  private sessionDir(id: string): string {
    // ids are agent-supplied (e.g. "fake-session-1"); sanitize for fs safety.
    const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.sessionsDir, safe);
  }

  /** Run a mutation serialized against all other persistence writes. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.rosterPath, "utf8");
      const parsed = JSON.parse(raw) as Roster;
      if (parsed && Array.isArray(parsed.sessions)) {
        for (const s of parsed.sessions) {
          if (s?.snapshot?.id) this.roster.set(s.snapshot.id, s);
        }
      }
    } catch {
      // no roster yet / corrupt -> start empty.
    }
  }

  private async writeRoster(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const roster: Roster = {
      version: ROSTER_VERSION,
      sessions: [...this.roster.values()],
    };
    const tmp = this.rosterPath + ".tmp";
    await writeFile(tmp, JSON.stringify(roster, null, 2));
    await rename(tmp, this.rosterPath);
  }

  saveSession(rec: PersistedSession): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.roster.set(rec.snapshot.id, rec);
      const dir = this.sessionDir(rec.snapshot.id);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, "meta.json.tmp");
      await writeFile(tmp, JSON.stringify(rec, null, 2));
      await rename(tmp, join(dir, "meta.json"));
      await this.writeRoster();
    });
  }

  appendTranscript(id: string, text: string): Promise<void> {
    if (!text) return Promise.resolve();
    return this.enqueue(async () => {
      const dir = this.sessionDir(id);
      await mkdir(dir, { recursive: true });
      const path = join(dir, "transcript.log");
      // append: read+concat is fine for our scale and keeps it dependency-free.
      let prev = "";
      try {
        prev = await readFile(path, "utf8");
      } catch {
        /* none yet */
      }
      await writeFile(path, prev + text);
    });
  }

  async readTranscript(id: string): Promise<string> {
    try {
      return await readFile(join(this.sessionDir(id), "transcript.log"), "utf8");
    } catch {
      return "";
    }
  }

  removeSession(id: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.roster.delete(id);
      try {
        await rm(this.sessionDir(id), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      await this.writeRoster();
    });
  }

  async loadRoster(): Promise<PersistedSession[]> {
    // drain pending writes, then read from disk (fresh process sees persisted state).
    await this.chain.catch(() => {});
    await this.ensureLoaded();
    return [...this.roster.values()];
  }

  async flush(): Promise<void> {
    await this.chain.catch(() => {});
  }
}

/** No-op persistence (in-process fallback / tests that don't want disk). */
export class NullPersistence implements Persistence {
  async saveSession(): Promise<void> {}
  async appendTranscript(): Promise<void> {}
  async readTranscript(): Promise<string> {
    return "";
  }
  async removeSession(): Promise<void> {}
  async loadRoster(): Promise<PersistedSession[]> {
    return [];
  }
  async flush(): Promise<void> {}
}

/** Resolve the daemon state root + socket path from the config dir. */
export function daemonPaths(configDir: string): {
  configDir: string;
  stateDir: string;
  socketPath: string;
  pidPath: string;
} {
  const stateDir = join(configDir, "daemon");
  return {
    configDir,
    stateDir,
    socketPath: join(configDir, "daemon.sock"),
    pidPath: join(configDir, "daemon.pid"),
  };
}

/** List session dirs present on disk (debug / recovery aid). */
export async function listSessionDirs(stateDir: string): Promise<string[]> {
  try {
    return await readdir(join(stateDir, "sessions"));
  } catch {
    return [];
  }
}
