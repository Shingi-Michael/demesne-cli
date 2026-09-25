import {
  type ImageArtifact,
  type ArtifactPage,
  EventStreamHttpError,
  isRecord,
  readServerSentEvents,
  type ArchiveSessionResponse,
  type CancelTurnResponse,
  type CompactSessionRequest,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type DaemonStatusResponse,
  type EventEnvelope,
  type ModelDescriptor,
  type PermissionDecision,
  type RuntimeProfileStatus,
  type Session,
  type SessionStateResponse,
  type SubmitTurnRequest,
  type SubmitTurnResponse,
  type TurnChangesResponse,
  type UndoSessionRequest,
  type UndoTurnResponse,
  type UpdateSessionRequest,
  type UpdateSessionResponse,
} from "@demesne/protocol";

/// Typed client for the Demesne daemon.
///
/// Every method maps to one route and returns protocol types. The event stream
/// reconnects with exponential backoff, resumes from the last seen event ID,
/// and stops on 4xx responses, which are terminal rather than transient. The
/// transport is injectable for tests and alternative runtimes.

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function isStalePermissionResolution(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409 && error.code === "invalid_state";
}

export interface DemesneClientOptions {
  server: string;
  token?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retry?: { initialDelayMs?: number; maxDelayMs?: number };
}

export interface HealthResponse {
  status: string;
  provider: string;
  model: string;
  version?: string;
}

export class DemesneClient {
  readonly server: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(options: DemesneClientOptions) {
    this.server = options.server;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.retryInitialDelayMs = options.retry?.initialDelayMs ?? 100;
    this.retryMaxDelayMs = options.retry?.maxDelayMs ?? 2_000;
  }

  /// Low-level JSON request. Typed methods are preferred; this exists for
  /// routes added by newer daemons than the client knows about.
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.server), {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = parseApiError(body) ?? `Request failed with HTTP ${response.status}`;
      throw new ApiRequestError(message, response.status, parseApiErrorCode(body));
    }
    return body as T;
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/healthz");
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return (await this.request<{ models: ModelDescriptor[] }>("/v1/models")).models;
  }

  async setModel(model: string): Promise<void> {
    await this.request("/v1/model", { method: "POST", body: JSON.stringify({ model }) });
  }

  async runtimeStatus(): Promise<RuntimeProfileStatus> {
    return this.request<RuntimeProfileStatus>("/v1/runtime");
  }

  async status(): Promise<DaemonStatusResponse> {
    return this.request<DaemonStatusResponse>("/v1/status");
  }

  async listSessions(query?: string): Promise<Session[]> {
    const trimmed = query?.trim();
    const path = trimmed ? `/v1/sessions?query=${encodeURIComponent(trimmed)}` : "/v1/sessions";
    return (await this.request<{ sessions: Session[] }>(path)).sessions;
  }

  async createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.request<CreateSessionResponse>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async getSessionState(sessionId: string): Promise<SessionStateResponse> {
    return this.request<SessionStateResponse>(`/v1/sessions/${sessionId}`);
  }

  async listArtifacts(sessionId: string, after = 0): Promise<ArtifactPage> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts?after=${after}&limit=100`);
  }

  async getArtifact(sessionId: string, id: string): Promise<ImageArtifact> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(id)}`);
  }

  async artifactContent(artifact: ImageArtifact, variant: "preview" | "original" = "preview", signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.fetchImpl(new URL(`/v1/sessions/${encodeURIComponent(artifact.sessionId)}/artifacts/${encodeURIComponent(artifact.id)}/content?variant=${variant}`, this.server), { headers: this.authHeaders(), signal });
    if (!response.ok) throw new ApiRequestError("Image content unavailable", response.status, null);
    const limit = 20 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Image exceeds preview budget"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Image content is empty");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new Error("Image exceeds preview budget"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  async updateSession(sessionId: string, request: UpdateSessionRequest): Promise<UpdateSessionResponse> {
    return this.request<UpdateSessionResponse>(`/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  }

  async archiveSession(sessionId: string): Promise<ArchiveSessionResponse> {
    return this.request<ArchiveSessionResponse>(`/v1/sessions/${sessionId}`, { method: "DELETE" });
  }

  async listWorkspaceFiles(sessionId: string): Promise<string[]> {
    return (await this.request<{ files: string[] }>(`/v1/sessions/${sessionId}/files`)).files;
  }

  async listWorkspaceFileInfo(sessionId: string): Promise<import("@demesne/protocol").WorkspaceFileInfo[]> {
    const response = await this.request<{ entries?: import("@demesne/protocol").WorkspaceFileInfo[]; files?: string[] }>(`/v1/sessions/${sessionId}/files?details=1`);
    return response.entries ?? (response.files ?? []).map((path) => ({ path, byteLength: null, status: null }));
  }

  async exportSession(sessionId: string, format: "md" | "json" = "md"): Promise<string> {
    const response = await this.fetchImpl(
      new URL(`/v1/sessions/${sessionId}/export?format=${format}`, this.server),
      { headers: this.authHeaders() },
    );
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw new ApiRequestError(
        parseApiError(body) ?? `Export failed with HTTP ${response.status}`,
        response.status,
        parseApiErrorCode(body),
      );
    }
    return response.text();
  }

  async submitTurn(sessionId: string, request: SubmitTurnRequest): Promise<SubmitTurnResponse> {
    return this.request<SubmitTurnResponse>(`/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async cancelTurn(turnId: string): Promise<CancelTurnResponse> {
    return this.request<CancelTurnResponse>(`/v1/turns/${turnId}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async compactSession(sessionId: string, request: CompactSessionRequest = {}): Promise<SubmitTurnResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/compact`, { method: "POST", body: JSON.stringify(request) });
  }

  async resolvePermission(permissionId: string, decision: PermissionDecision): Promise<void> {
    await this.request(`/v1/permissions/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  }

  async undo(sessionId: string, request: UndoSessionRequest = {}): Promise<UndoTurnResponse> {
    return this.request<UndoTurnResponse>(`/v1/sessions/${sessionId}/undo`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async changes(sessionId: string, turnId?: string): Promise<TurnChangesResponse> {
    const path = turnId
      ? `/v1/sessions/${sessionId}/changes?turn=${encodeURIComponent(turnId)}`
      : `/v1/sessions/${sessionId}/changes`;
    return this.request<TurnChangesResponse>(path);
  }

  async *streamEvents(
    sessionId: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<EventEnvelope> {
    let cursor = after;
    let retryDelay = this.retryInitialDelayMs;
    while (!signal?.aborted) {
      try {
        const url = new URL("/v1/events", this.server);
        url.searchParams.set("session_id", sessionId);
        url.searchParams.set("after", String(cursor));
        const response = await this.fetchImpl(url, {
          headers: {
            ...(cursor > 0 ? { "Last-Event-ID": String(cursor) } : {}),
            ...this.authHeaders(),
          },
          signal,
        });
        for await (const event of readServerSentEvents(response)) {
          cursor = Math.max(cursor, event.eventId);
          retryDelay = this.retryInitialDelayMs;
          yield event;
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof SyntaxError) throw error;
        if (error instanceof EventStreamHttpError && error.status >= 400 && error.status < 500) throw error;
      }
      await this.sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, this.retryMaxDelayMs);
    }
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }
}

function parseApiError(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") return null;
  return value.error.message;
}

function parseApiErrorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string") return null;
  return value.error.code;
}
