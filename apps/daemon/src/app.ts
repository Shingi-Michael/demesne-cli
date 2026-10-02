import { collectDriveReview } from "./drive-review.ts";
import { collectDriveFacts, driveTrackedPaths } from "./drive-facts.ts";
import { CommandMonitor } from "./command-monitor.ts";
import { workspaceReview } from "./workspace-review.ts";
import type { ReviewScope } from "@demesne/protocol";
import { readArtifact, ingestImage } from "./artifacts.ts";
import {
  encodeServerSentEvent,
  isRecord,
  parseCreateSessionRequest,
  parseCompactSessionRequest,
  parseAnswerQuestionsRequest,
  parseResolvePermissionRequest,
  parseSubmitTurnRequest,
  parseUndoSessionRequest,
  parseUpdateSessionRequest,
  ProtocolValidationError,
  parseDriveRequest,
  type ApiErrorBody,
  type ArchiveSessionResponse,
  type CancelTurnResponse,
  type CreateSessionResponse,
  type DaemonStatusResponse,
  type EventEnvelope,
  type SubmitTurnResponse,
  type Turn,
  type TurnChangesResponse,
  type UndoSessionRequest,
  type UndoTurnResponse,
  type UpdateSessionResponse,
} from "@demesne/protocol";
import { DemesneStore, InvalidStateError, NotFoundError } from "@demesne/storage";
import { PlaceholderTurnProcessor, snapshotTurnInference, type TurnInference, type TurnProcessor } from "./processor.ts";
import { AgentEngine } from "./engine.ts";
import { SessionCompactor } from "./session-compaction.ts";
import type { ContextPlanner } from "./context-planner.ts";
import { runtimeProfileRequiresSingleInferenceSlot } from "./ollama-runtime.ts";
import { PermissionBroker } from "./permissions.ts";
import { QuestionBroker } from "./questions.ts";
import { ConfigAllowlist } from "./allowlist.ts";
import { canonicalWorkspace, listWorkspaceFiles, readWorkspaceText, resolveWorkspacePath, ToolRegistry, viewImageTool } from "./tools.ts";
import { detectGitBranch } from "./git-branch.ts";
import { formatSessionMarkdown } from "./session-export.ts";
import { SessionReplay } from "./session-replay.ts";
import { DRIVE_QUICK_TOKENS, DRIVE_THOUGHT_TOKENS, planDrive } from "./drive-planner.ts";
import { driveStream } from "./drive-stream.ts";
import { buildTurnChanges } from "./turn-changes.ts";
import { McpManager } from "./mcp.ts";
import { imageGenerationTool } from "./image-generation.ts";
import { captureWindowTool } from "./window-capture.ts";
import { workspaceFileInfo } from "./workspace-file-info.ts";
import type { AgentConfig, ImageGenerationConfig } from "@demesne/config";
import type { McpServerConfig } from "@demesne/config";
import { backgroundProcesses } from "./background.ts";
import { InferenceScheduler, InferenceSchedulers, type InferenceBoundaryHook } from "./inference-scheduler.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export { PlaceholderTurnProcessor, type TurnProcessor } from "./processor.ts";

type EventListener = (event: EventEnvelope) => void;

class EventHub {
  private readonly listeners = new Map<string, Set<EventListener>>();

  publish(event: EventEnvelope): void {
    this.listeners.get(event.sessionId)?.forEach((listener) => listener(event));
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }
}

export interface DaemonApp {
  fetch(request: Request): Response | Promise<Response>;
  /// Resolves once configured MCP servers have started and registered tools.
  ready: Promise<void>;
  close(): Promise<void>;
}

export function createDaemonApp(options: {
  databasePath: string;
  processor?: TurnProcessor;
  systemPrompt?: string;
  authToken?: string;
  version?: string;
  inferenceSlots?: number;
  allowlistPath?: string;
  mcpServers?: Record<string, McpServerConfig>;
  images?: ImageGenerationConfig;
  inferenceBoundaryHook?: InferenceBoundaryHook;
  contextPlanner?: ContextPlanner;
  providerFirstEventTimeoutMs?: number;
  providerRequestTimeoutMs?: number;
  providerEventLimit?: number;
  providerVision?: boolean;
  agent?: AgentConfig;
}): DaemonApp {
  if (options.images && Object.values(options.images).some((value) => value !== undefined)
    && (!options.images.url || !options.images.model)) throw new Error("Image generation requires both images.url and images.model");
  const hub = new EventHub();
  const store = new DemesneStore(options.databasePath, (event) => hub.publish(event));
  const replay = new SessionReplay(store);
  const processor: TurnProcessor = options.processor ?? new PlaceholderTurnProcessor();
  const allowlist = new ConfigAllowlist(options.allowlistPath ?? null);
  const invalidRules = allowlist.invalidEntries();
  if (invalidRules.length > 0) {
    console.warn(`Ignoring ${invalidRules.length} invalid permissions.allow entr${invalidRules.length === 1 ? "y" : "ies"}: ${invalidRules.join(", ")}`);
  }
  const permissions = new PermissionBroker(allowlist);
  const questions = new QuestionBroker();
  const inferenceSlots = options.inferenceSlots ?? 1;
  const runtimeProfile = processor.runtimeStatus?.().profile;
  if (runtimeProfileRequiresSingleInferenceSlot(runtimeProfile) && inferenceSlots !== 1) {
    store.close();
    throw new Error(`The ${runtimeProfile} runtime profile requires one inference slot`);
  }
  const scheduler = new InferenceSchedulers(new InferenceScheduler(inferenceSlots, undefined, options.inferenceBoundaryHook), processor.providerId);
  const tools = new ToolRegistry();
  if (options.providerVision || options.images?.model || Object.keys(options.mcpServers ?? {}).length) {
    tools.register(viewImageTool());
    if (process.platform === "darwin") tools.register(captureWindowTool());
  }
  if (options.images?.url && options.images.model) tools.register(imageGenerationTool(options.images, store));
  const mcp = new McpManager({
    servers: options.mcpServers ?? {},
    log: (message) => console.warn(message),
  });
  const mcpReady = mcp.serverCount > 0
    ? mcp.start(tools).catch((error) => {
        console.warn("MCP startup failed", error);
      })
    : Promise.resolve();
  const commands=new CommandMonitor(store);
  const engine = new AgentEngine(
    store,
    tools,
    permissions,
    scheduler,
    options.systemPrompt,
    options.contextPlanner,
    {
      providerFirstEventTimeoutMs: options.providerFirstEventTimeoutMs,
      providerRequestTimeoutMs: options.providerRequestTimeoutMs,
      providerEventLimit: options.providerEventLimit,
      providerVision: options.providerVision,
      questions,
      commands,
      inferenceFor: (model, thinkingEnabled) => snapshotTurnInference(processor, thinkingEnabled, { model }),
      ...options.agent,
    },
  );
  const activeTurns = new Set<Promise<void>>();
  const compactor = new SessionCompactor(store, scheduler, tools, options);
  const activeControllers = new Map<string, AbortController>();
  const activeStreamClosers = new Set<() => void>();
  const driveLifecycle = new AbortController();
  const activeDriveDecisions = new Set<Promise<unknown>>();
  const requestDrainWaiters = new Set<() => void>();
  let activeRequests = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function queueTurn(turn: Turn, inference: TurnInference): void {
    const controller = new AbortController();
    activeControllers.set(turn.id, controller);
    const task = runTurn(turn, inference, controller.signal).finally(() => {
      activeTurns.delete(task);
      activeControllers.delete(turn.id);
    });
    activeTurns.add(task);
  }

  async function runTurn(turn: Turn, inference: TurnInference, signal: AbortSignal): Promise<void> {
    try {
      if (turn.kind === "compaction") await compactor.run(turn.id, inference, signal);
      else await engine.run(turn.id, inference, signal);
    } catch (error) {
      if (signal.aborted) return;
      const detail = error instanceof Error ? error.message : "Unknown turn failure";
      const message = turn.kind === "compaction" ? `Compaction failed: ${detail}. Previous context remains active.` : detail;
      try {
        store.failTurn(turn.id, message);
      } catch (persistenceError) {
        console.error(`Could not persist failure for turn ${turn.id}`, persistenceError);
      }
    } finally {
      scheduler.finishTurn(turn.id);
    }
  }

  async function undoSession(sessionId: string, request: UndoSessionRequest): Promise<Response> {
    const target = store.undoableTurn(sessionId, request.turnId);
    if (!target) return apiError("not_found", "No reversible turn with snapshots", 404);
    const workspaceRoot = store.getSession(sessionId)?.workspace?.root;
    if (!workspaceRoot) return apiError("invalid_state", "Session has no workspace", 409);

    // Work that can edit files must settle first; summarizing the conversation
    // edits nothing, and an undo during it invalidates the stale checkpoint.
    const editing = store.getSession(sessionId)?.turns.some((turn) => turn.kind !== "compaction" && (turn.status === "running" || turn.status === "queued"));
    if (editing || commands.runningInWorkspace(workspaceRoot)) return apiError("invalid_state", "Wait for running work before undoing changes", 409);
    const requested = request.paths ? new Set(request.paths) : null;
    if (requested) {
      const known = new Set(target.files.map((file) => file.path));
      for (const path of requested) {
        if (!known.has(path)) {
          return apiError("invalid_state", `Path is not part of turn ${target.turnId.slice(0, 8)}: ${path}`, 409);
        }
      }
    }
    const selected = requested ? target.files.filter((file) => requested.has(file.path)) : target.files;
    if (selected.length === 0) return apiError("invalid_state", "No matching files to revert", 409);

    const prepared: Array<{ file: (typeof selected)[number]; absolute: string; current: Uint8Array | null }> = [];
    try {
      for (const file of [...selected].reverse()) {
        if (file.postExisted === null || file.postExisted === undefined) {
          return apiError("invalid_state", "Snapshot predates conflict-safe undo", 409);
        }
        const absolute = resolveWorkspacePath(workspaceRoot, file.path, true, true);
        const exists = existsSync(absolute);
        if (exists !== file.postExisted) return apiError("conflict", `Workspace changed at ${file.path}; undo refused`, 409);
        let current: Uint8Array | null = null;
        if (exists) {
          const stat = lstatSync(absolute);
          if (!stat.isFile() || stat.nlink > 1) return apiError("conflict", `Workspace changed at ${file.path}; undo refused`, 409);
          current = new Uint8Array(readFileSync(absolute));
          if (!file.postHash || hashBytes(current) !== file.postHash) {
            return apiError("conflict", `Workspace changed at ${file.path}; undo refused`, 409);
          }
        }
        prepared.push({ file, absolute, current });
      }
    } catch {
      return apiError("conflict", "Workspace boundary changed; undo refused", 409);
    }

    const applied: typeof prepared = [];
    try {
      for (const entry of prepared) {
        restoreFile(entry.absolute, entry.file.existed ? entry.file.data : null);
        applied.push(entry);
      }
    } catch (error) {
      console.error("Undo failed; restoring post-turn state", error);
      for (const entry of [...applied].reverse()) {
        try { restoreFile(entry.absolute, entry.current); } catch (rollbackError) {
          console.error("Undo rollback failed for", entry.absolute, rollbackError);
        }
      }
      return apiError("invalid_state", "Undo could not be completed", 409);
    }
    const reverted = prepared.map((entry) => entry.file.path);
    commands.invalidate(workspaceRoot);
    const { event, complete } = store.markTurnReverted(sessionId, target.turnId, reverted);
    const response: UndoTurnResponse = { turnId: target.turnId, files: reverted, complete };
    return json({ ...response, eventId: event.eventId });
  }

  async function fetch(request: Request): Promise<Response> {
    if (closing) return apiError("shutting_down", "Daemon is shutting down", 503);
    activeRequests += 1;
    try {
      const url = new URL(request.url);
      const path = url.pathname.split("/").filter(Boolean);

      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({
          status: "ok",
          provider: processor.providerId,
          model: processor.modelId,
          // Reported so a client can show the configured window even when the
          // model server is down and /v1/models cannot be served.
          ...(processor.contextCapacity !== undefined ? { contextCapacity: processor.contextCapacity } : {}),
          ...(options.version ? { version: options.version } : {}),
        });
      }

      if (options.authToken && request.headers.get("authorization") !== `Bearer ${options.authToken}`) {
        return apiError("unauthorized", "Daemon authentication required", 401);
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        try {
          return json({ models: await processor.listModels(request.signal) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Model discovery failed";
          return apiError("provider_error", message, 502);
        }
      }

      if (request.method === "POST" && path.length === 5 && path[0] === "v1" && path[1] === "sessions" && path[3] === "drive" && path[4] === "facts") {
        const input = await readJson(request);
        if (!isRecord(input) || input.turnId !== undefined && typeof input.turnId !== "string" || !Array.isArray(input.paths) || input.paths.length > 128 || input.paths.some(p => typeof p !== "string" || p.length > 4096)) return apiError("invalid_request", "Expected a turn ID and up to 128 workspace paths", 400);
        return json(collectDriveFacts(store,commands,path[2]!,input.turnId as string | undefined,input.paths as string[]));
      }

      if (request.method === "POST" && url.pathname === "/v1/drive/check-in/cancel") {
        const body=await readJson(request);
        if(!isRecord(body)||typeof body.sessionId!=="string"||typeof body.turnId!=="string"||typeof body.revision!=="string"||!/^[a-f0-9]{64}$/.test(body.revision)) return apiError("invalid_request","Expected session, worker turn, and review revision",400);
        const current=store.getTurn(body.turnId);
        if(!current||current.sessionId!==body.sessionId)return apiError("not_found","Drive worker not found in session",404);
        const controller=activeControllers.get(current.id);
        if(!controller||current.status!=="running")return json({cancelled:false,reason:"Worker has already settled."});
        const {review}=collectDriveReview(store,commands,body.sessionId,body.turnId);
        if(review.waitingForHuman||review.revision!==body.revision)return json({cancelled:false,reason:"Recorded evidence changed or the worker is waiting for human input."});
        // No await between this comparison and cancellation: tools cannot
        // publish a new outcome in between the guard and the stop.
        store.cancelTurn(current.id); controller.abort(new DOMException("Drive checkpoint correction","AbortError"));
        permissions.cancelTurn(current.id,controller.signal.reason); questions.cancelTurn(current.id,controller.signal.reason);
        return json({cancelled:true});
      }

      if (request.method === "POST" && url.pathname === "/v1/drive/decide") {
        const body = parseDriveRequest(await readJson(request));
        delete body.review; // Only the daemon may author handoff evidence.
        const home = store.getSession(body.homeSessionId), viewed = store.getSession(body.observation.sessionId);
        if (!home || !viewed) return apiError("not_found", "Drive session not found", 404);
        if (!home.workspace || home.workspace.root !== viewed.workspace?.root || home.workspace.root !== body.observation.workspace)
          return apiError("invalid_state", "Drive observations must belong to the mission's workspace", 409);
        if (body.checkIn) {
          const worker=store.getTurn(body.checkIn.turnId);
          if(!worker || worker.sessionId!==body.homeSessionId) return apiError("invalid_request","Drive check-in must reference a worker in the home session",400);
        }
        const signal = AbortSignal.any([request.signal, driveLifecycle.signal]);
        // Each attempt's model call: thinking on or off, under Drive's cap.
        const inferenceFor = (thinking: boolean | undefined) => snapshotTurnInference(processor, thinking,
          { maxOutputTokens: thinking === false ? DRIVE_QUICK_TOKENS : DRIVE_THOUGHT_TOKENS });
        const decide = (signal: AbortSignal, progress?: Parameters<typeof planDrive>[5]) => {
          const planned = (async () => {
            const leaseId = `drive:${randomUUID()}`;
            const slots = scheduler.for(processor.providerId);
            const lease = await slots.acquire(leaseId, signal, body.checkIn ? {reviewFor:body.checkIn.turnId} : {});
            try {
              if(body.checkIn?.freshEvidence) {
                const packet=collectDriveReview(store,commands,body.homeSessionId,body.checkIn.turnId,body.checkIn.reason,lease.queueDurationMs);
                body.review=packet.review; body.facts=packet.facts;
                const skipped=packet.review.status!=="running" ? "Worker settled before the review acquired a model slot." : packet.review.waitingForHuman ? "Worker is waiting for human input; check-in skipped." : !packet.review.rows.length ? "No recorded tool activity is available for this check-in." : undefined;
                if(skipped){const inference=inferenceFor(false);return {review:packet.review,skipped,provider:inference.providerId,model:inference.modelId,imageInspected:false,decision:{action:{kind:"keep_working" as const},note:skipped,notes:body.memory.notes,completed:body.memory.completed,remaining:body.memory.remaining,evidence:[]}};}
                await progress?.({type:"review.ready",review:packet.review});
              }
              let image: { id: string; url: string } | undefined;
              if (!body.checkIn && options.providerVision && body.observation.surface === "preview" && body.observation.artifactId) {
                const artifact = store.getImageArtifact(viewed.id, body.observation.artifactId);
                if (artifact) { const bytes = await readArtifact(store, artifact, true); image = { id: artifact.id, url: `data:image/png;base64,${bytes.toString("base64")}` }; }
              }
              // Refresh after acquiring the model slot; never trust caller-supplied results.
              if (!body.checkIn && body.ledger && body.facts) body.facts = collectDriveFacts(store,commands,body.homeSessionId,(body.observation.sessionId !== body.homeSessionId || ["0","start"].includes(body.observation.navigation?.turn ?? "") ? undefined : body.observation.navigation?.turn) || undefined,driveTrackedPaths(body.ledger));
              const reviewStarted=performance.now();
              const result=await planDrive(body, inferenceFor, signal, options, image, progress);
              if(body.review)body.review.modelMs=Math.round(performance.now()-reviewStarted);
              return {...result,...(body.review?{review:body.review}:{})};
            } finally { lease.release({ turnContinues: false }); slots.finishTurn(leaseId); }
          })();
          activeDriveDecisions.add(planned);
          void planned.then(() => activeDriveDecisions.delete(planned), () => activeDriveDecisions.delete(planned));
          return planned;
        };
        if (request.headers.get("accept")?.includes("text/event-stream")) return driveStream(signal, decide);
        try {
          return json(await decide(signal));
        } catch (error) {
          return apiError("provider_error", error instanceof Error ? error.message : "Drive planning failed", 502);
        }
      }

      if (request.method === "GET" && url.pathname === "/v1/runtime") {
        return json(processor.runtimeStatus?.() ?? {
          profile: null,
          state: "unconfigured",
          expected: null,
          observed: null,
          mismatches: [],
          observedAt: null,
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/status") {
        const response: DaemonStatusResponse = {
          ...(options.version ? { version: options.version } : {}),
          provider: processor.providerId,
          model: processor.modelId,
          inferenceSlots,
          activeInferences: scheduler.activeCount,
          queuedInferences: scheduler.queuedCount,
          active: store.listActiveTurns().map((entry) => ({
            id: entry.sessionId,
            title: entry.title,
            workspace: entry.workspaceRoot,
            turnId: entry.turnId,
            turnStatus: entry.status,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          })),
        };
        return json(response);
      }

      if (request.method === "POST" && url.pathname === "/v1/model") {
        const body = await readJson(request);
        if (!isRecord(body) || typeof body.model !== "string" || !body.model.trim()) {
          return apiError("invalid_request", "model must be a non-empty string", 400);
        }
        const modelName = body.model.trim();
        if (processor && typeof processor.setModel === "function") {
          processor.setModel(modelName);
          return json({ status: "ok", model: modelName });
        }
        return apiError("not_supported", "Model switching is not supported by this processor", 400);
      }

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = parseCreateSessionRequest(await readJson(request));
        let workspaceRoot: string | undefined;
        if (body.workspacePath) {
          try {
            workspaceRoot = canonicalWorkspace(body.workspacePath);
            const dataRoot = realpathSync(dirname(options.databasePath));
            if (pathsOverlap(workspaceRoot, dataRoot)) {
              return apiError("invalid_workspace", "Workspace cannot overlap the Demesne data directory", 400);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid workspace";
            return apiError("invalid_workspace", message, 400);
          }
        }
        const { session, event } = store.createSession(body.title, workspaceRoot);
        const response: CreateSessionResponse = { session, eventId: event.eventId };
        return json(response, 201);
      }

      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        const query = url.searchParams.get("query")?.trim();
        return json({ sessions: query ? store.searchSessions(query) : store.listSessions() });
      }

      if (request.method === "PATCH" && path.length === 3 && path[0] === "v1" && path[1] === "sessions") {
        const body = parseUpdateSessionRequest(await readJson(request));
        let session = store.getSession(path[2]!);
        if (!session) return apiError("not_found", "Session not found", 404);
        let eventId: number | null = null;
        if (body.title !== undefined) {
          const renamed = store.renameSession(path[2]!, body.title);
          session = renamed.session;
          eventId = renamed.event.eventId;
        }
        if (body.preferredModel !== undefined) {
          session = store.setSessionPreferredModel(path[2]!, body.preferredModel);
        }
        const response: UpdateSessionResponse = { session, eventId };
        return json(response);
      }

      if (request.method === "DELETE" && path.length === 3 && path[0] === "v1" && path[1] === "sessions") {
        const { session, event } = store.archiveSession(path[2]!);
        const response: ArchiveSessionResponse = { session, eventId: event.eventId };
        return json(response);
      }

      if (request.method === "GET" && path.length === 4 && path[0] === "v1" && path[1] === "sessions" && path[3] === "export") {
        const format = url.searchParams.get("format") ?? "md";
        if (format !== "md" && format !== "json") {
          return apiError("invalid_request", "format must be md or json", 400);
        }
        const exported = store.getSessionExport(path[2]!);
        if (format === "json") return json(exported);
        return new Response(formatSessionMarkdown(exported), {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      }

      if(request.method==="POST"&&path.length===5&&path[0]==="v1"&&path[1]==="sessions"&&path[3]==="artifacts"&&path[4]==="import"){
        const session=store.getSession(path[2]!);if(!session?.workspace)return apiError("not_found","Workspace session not found",404);
        const turn=session.turns.at(-1);if(!turn)return apiError("invalid_state","Start a conversation before importing a reference",409);
        const body=await readJson(request);if(!isRecord(body)||typeof body.path!=="string"||body.path.length>4096)return apiError("invalid_request","A workspace image path is required",400);
        try{const output=await viewImageTool().executeWithArtifacts!({path:body.path},{workspaceRoot:session.workspace.root,sessionId:session.id,signal:request.signal});
          if(typeof output==="string"||!output.images.length)return apiError("invalid_request","Image unavailable",400);
          if(body.viewport!==undefined){const viewport=body.viewport;if(!isRecord(viewport)||![viewport.width,viewport.height].every(value=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=32768)||(viewport.deviceScaleFactor!==undefined&&(!(typeof viewport.deviceScaleFactor==="number")||viewport.deviceScaleFactor<=0||viewport.deviceScaleFactor>8)))return apiError("invalid_request","Invalid viewport dimensions",400);output.images[0]!.viewport={width:Number(viewport.width),height:Number(viewport.height),...(typeof viewport.deviceScaleFactor==="number"?{deviceScaleFactor:viewport.deviceScaleFactor}:{})};}
          const artifact=await ingestImage(store,output.images[0]!,{sessionId:session.id,turnId:turn.id,toolCallId:randomUUID(),name:body.reference===true?"reference_import":"image_import"},0);return json(artifact,201);
        }catch(error){return apiError("invalid_request",error instanceof Error?error.message:String(error),400);}
      }

      if (request.method === "GET" && path[0] === "v1" && path[1] === "sessions" && path[3] === "artifacts") {
        const sessionId = path[2]!;
        if (!store.getSession(sessionId)) return apiError("not_found", "Session not found", 404);
        if (path.length === 4) {
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 50);
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return apiError("invalid_request", "Invalid artifact cursor or limit", 400);
          return json(store.listImageArtifacts(sessionId, after, limit));
        }
        const artifact = store.getImageArtifact(sessionId, path[4]!);
        if (!artifact) return apiError("not_found", "Artifact not found", 404);
        if (path.length === 5) return json(artifact);
        if (path.length === 6 && path[5] === "content") {
          const variant = url.searchParams.get("variant") ?? "preview";
          if (variant !== "preview" && variant !== "original") return apiError("invalid_request", "Invalid image variant", 400);
          try {
            const bytes = await readArtifact(store, artifact, variant === "preview");
            return new Response(new Uint8Array(bytes), { headers: { "Content-Type": variant === "preview" ? "image/png" : artifact.mimeType,
              "Content-Length": String(bytes.byteLength), "ETag": `"${artifact.sha256}-${variant}"` } });
          } catch { return apiError("not_found", "Image content unavailable", 404); }
        }
      }

      if (request.method === "GET" && path.length === 4 && path[0] === "v1" && path[1] === "sessions" && path[3] === "file") {
        // One file's text for the viewer: GET /v1/sessions/:id/file?path=src/a.ts
        const session = store.getSession(path[2]!);
        if (!session) return apiError("not_found", "Session not found", 404);
        if (!session.workspace) return apiError("invalid_state", "Session has no workspace", 409);
        const target = url.searchParams.get("path");
        if (!target) return apiError("invalid_request", "path is required", 400);
        const file = readWorkspaceText(session.workspace.root, target);
        if (url.searchParams.get("status") === "1") {
          const { content, ...status } = file;
          return json(status);
        }
        return json(file);
      }

      if (request.method === "GET" && path.length === 4 && path[0] === "v1" && path[1] === "sessions" && path[3] === "files") {
        const session = store.getSession(path[2]!);
        if (!session) return apiError("not_found", "Session not found", 404);
        if (!session.workspace) return apiError("invalid_state", "Session has no workspace", 409);
        if (url.searchParams.get("details") === "1") return json({ entries: workspaceFileInfo(session.workspace.root) });
        return json({ files: listWorkspaceFiles(session.workspace.root) });
      }

      if (request.method === "GET" && path.length === 3 && path[0] === "v1" && path[1] === "sessions") {
        const state = store.getSessionState(path[2]!);
        if (!state) return apiError("not_found", "Session not found", 404);
        const branch = state.session.workspace ? await detectGitBranch(state.session.workspace.root) : null;
        const session = state.session.workspace && branch
          ? { ...state.session, workspace: { ...state.session.workspace, gitBranch: branch } }
          : state.session;
        return json({ ...state, session, sessionGrants: permissions.listGrants(path[2]!) });
      }

      if (request.method === "POST" && path.length === 4 && path[0] === "v1" && path[1] === "sessions" && path[3] === "compact") {
        const body = parseCompactSessionRequest(await readJson(request));
        const inference = snapshotTurnInference(processor, false);
        const { turn, event } = store.createTurn(path[2]!, `/compact${body.instructions ? ` ${body.instructions}` : ""}`, "deny", false, false, "compaction");
        queueTurn(turn, inference);
        return json({ turn, eventId: event.eventId } satisfies SubmitTurnResponse, 202);
      }

      if (
        request.method === "POST" &&
        path.length === 4 &&
        path[0] === "v1" &&
        path[1] === "sessions" &&
        path[3] === "turns"
      ) {
        const body = parseSubmitTurnRequest(await readJson(request));
        let inference: TurnInference;
        try {
          inference = snapshotTurnInference(processor, body.thinkingEnabled);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Turn processor cannot snapshot inference configuration";
          return apiError("not_supported", message, 400);
        }
        const { turn, event } = store.createTurn(
          path[2]!,
          body.content,
          body.permissionMode ?? "deny",
          body.thinkingEnabled,
          body.planOnly ?? false,
        );
        queueTurn(turn, inference);
        const response: SubmitTurnResponse = { turn, eventId: event.eventId };
        return json(response, 202);
      }

      if (request.method === "POST" && path.length === 3 && path[0] === "v1" && path[1] === "questions") {
        const body = parseAnswerQuestionsRequest(await readJson(request));
        if (!questions.resolve(path[2]!, body.answers)) {
          return apiError("invalid_state", "Question is no longer pending, or the answers do not match what was asked", 409);
        }
        return json({ questionId: path[2] }, 202);
      }

      if (
        request.method === "POST" &&
        path.length === 3 &&
        path[0] === "v1" &&
        path[1] === "permissions"
      ) {
        const body = parseResolvePermissionRequest(await readJson(request));
        if (!permissions.resolve(path[2]!, body.decision)) {
          return apiError("invalid_state", "Permission is no longer pending", 409);
        }
        return json({ permissionId: path[2], decision: body.decision }, 202);
      }

      if (
        request.method === "POST" &&
        path.length === 4 &&
        path[0] === "v1" &&
        path[1] === "turns" &&
        path[3] === "cancel"
      ) {
        const turnId = path[2]!;
        const controller = activeControllers.get(turnId);
        if (!controller) {
          const turn = store.getTurn(turnId);
          if (!turn) return apiError("not_found", "Turn not found", 404);
          return apiError("invalid_state", `Turn cannot be cancelled from ${turn.status}`, 409);
        }
        const { turn, event } = store.cancelTurn(turnId);
        controller.abort(new DOMException("Turn cancelled", "AbortError"));
        permissions.cancelTurn(turnId, controller.signal.reason);
        questions.cancelTurn(turnId, controller.signal.reason);
        const response: CancelTurnResponse = { turn, eventId: event.eventId };
        return json(response);
      }

      if (
        request.method === "POST" &&
        path.length === 4 &&
        path[0] === "v1" &&
        path[1] === "sessions" &&
        path[3] === "undo"
      ) {
        return undoSession(path[2]!, parseUndoSessionRequest(await readOptionalJson(request)));
      }

      if(path[0]==="v1"&&path[1]==="sessions"&&path[2]&&["review","commands"].includes(path[3]??"")){
        const session=store.getSession(path[2]);if(!session?.workspace)return apiError("not_found","Workspace session not found",404);
        if(request.method==="GET"&&path[3]==="review"&&path.length===4){
          const scope=url.searchParams.get("scope")??"turn";if(!["turn","session","workspace"].includes(scope))return apiError("invalid_request","Invalid review scope",400);
          try{return json(workspaceReview(store,session.id,scope as ReviewScope,url.searchParams.get("turn")??session.turns.at(-1)?.id));}catch(error){return apiError("review_unavailable",error instanceof Error?error.message:String(error),400);}
        }
        if(request.method==="GET"&&path[3]==="commands"&&path.length===4){const active=session.turns.findLast(turn=>turn.status==="running"||turn.status==="queued");return json({...commands.list(session.id,session.workspace.root,url.searchParams.get("output")??"all"),queuePosition:active?scheduler.queuePosition(active.id):null});}
        if(request.method==="POST"&&path[3]==="commands"&&path.length===6){
          if(path[5]==="stop")return commands.stop(session.id,path[4]!)?json({stopping:true},202):apiError("not_found","No running command with this id in this session",404);
          if(path[5]==="rerun"){try{return json({id:await commands.rerun(session.id,path[4]!,tools.get("run_command")!)},202);}catch(error){return apiError("invalid_state",error instanceof Error?error.message:String(error),409);}}
        }
      }

      if (request.method === "GET" && path.length === 4 && path[0] === "v1" && path[1] === "sessions" && path[3] === "changes") {
        const sessionId = path[2]!;
        const session = store.getSession(sessionId);
        if (!session) return apiError("not_found", "Session not found", 404);
        if (!session.workspace) return apiError("invalid_state", "Session has no workspace", 409);
        const requestedTurn = url.searchParams.get("turn")?.trim();
        const target = requestedTurn ? store.undoableTurn(sessionId, requestedTurn) ?? { turnId: requestedTurn } : store.undoableTurn(sessionId);
        if (!target) return apiError("not_found", "No turn with snapshots to review", 404);
        const snapshots = store.snapshotsForTurn(sessionId, target.turnId);
        if (!snapshots) return apiError("not_found", "Turn not found", 404);
        const workspaceRoot = session.workspace.root;
        const changes = buildTurnChanges(snapshots, {
          readCurrent: (relativePath) => {
            try {
              const absolute = resolveWorkspacePath(workspaceRoot, relativePath, true, true);
              if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return null;
              return readFileSync(absolute).toString("utf8");
            } catch {
              return null;
            }
          },
        });
        const response: TurnChangesResponse = { turnId: target.turnId, changes };
        return json(response);
      }

      if (request.method === "GET" && path.length === 4 && path[0] === "v1" && path[1] === "sessions" && path[3] === "replay") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const through = Number(url.searchParams.get("through"));
        if (!url.searchParams.has("through") || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < after) {
          return apiError("invalid_request", "Valid after and through history cursors are required", 400);
        }
        return new Response(replay.page(path[2]!, after, through), {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/events") {
        const sessionId = url.searchParams.get("session_id")?.trim();
        if (!sessionId) return apiError("invalid_request", "session_id is required", 400);
        if (!store.getSession(sessionId)) return apiError("not_found", "Session not found", 404);
        const after = parseEventCursor(url.searchParams.get("after"), request.headers.get("last-event-id"));
        return eventStream(store, hub, sessionId, after, (close) => {
          activeStreamClosers.add(close);
          return () => activeStreamClosers.delete(close);
        });
      }

      return apiError("not_found", "Route not found", 404);
    } catch (error) {
      if (error instanceof NotFoundError) return apiError("not_found", error.message, 404);
      if (error instanceof InvalidStateError) return apiError("invalid_state", error.message, 409);
      if (error instanceof SyntaxError) return apiError("invalid_json", "Request body is not valid JSON", 400);
      if (error instanceof ProtocolValidationError) return apiError("invalid_request", error.message, 400);
      console.error("Unhandled daemon request error", error);
      return apiError("internal_error", "Unexpected server error", 500);
    } finally {
      activeRequests -= 1;
      if (activeRequests === 0) {
        for (const resolve of requestDrainWaiters) resolve();
        requestDrainWaiters.clear();
      }
    }
  }

  return {
    fetch,
    ready: mcpReady,
    close() {
      closePromise ??= closeApplication();
      return closePromise;
    },
  };

  async function closeApplication(): Promise<void> {
      closing = true;
      driveLifecycle.abort(new DOMException("Daemon shutting down", "AbortError"));
      for (const close of [...activeStreamClosers]) close();
      if (activeRequests > 0) {
        await new Promise<void>((resolve) => requestDrainWaiters.add(resolve));
      }
      for (const [turnId, controller] of activeControllers) {
        const turn = store.getTurn(turnId);
        if (turn?.status === "queued" || turn?.status === "running") store.cancelTurn(turnId);
        controller.abort(new DOMException("Daemon shutting down", "AbortError"));
        permissions.cancelTurn(turnId, controller.signal.reason);
        questions.cancelTurn(turnId, controller.signal.reason);
      }
      await scheduler.close(new DOMException("Daemon shutting down", "AbortError"));
      await Promise.allSettled(activeTurns);
      await Promise.allSettled(activeDriveDecisions);
      await mcpReady.catch(() => undefined);
      mcp.stop();
      await commands.close();
      backgroundProcesses.shutdownAll();
      store.close();
  }
}

function restoreFile(absolute: string, data: Uint8Array | null): void {
  if (data === null) {
    if (existsSync(absolute)) {
      if (!lstatSync(absolute).isFile()) throw new Error("Undo target is not a regular file");
      unlinkSync(absolute);
    }
    return;
  }
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(absolute), `.demesne-undo-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    renameSync(temporary, absolute);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function hashBytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function eventStream(
  store: DemesneStore,
  hub: EventHub,
  sessionId: string,
  afterEventId: number,
  registerCloser: (close: () => void) => () => void,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let deregisterCloser = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let cursor = afterEventId;
  let replayComplete = false;
  let replayBuffer: EventEnvelope[] = [];

  const cleanup = () => {
    unsubscribe();
    deregisterCloser();
    if (heartbeat) clearInterval(heartbeat);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    cleanup();
    try {
      streamController?.close();
    } catch {
      // The client may already have cancelled the stream.
    }
  };

  const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, event: EventEnvelope) => {
    if (closed || event.eventId <= cursor) return;
    cursor = event.eventId;
    controller.enqueue(encoder.encode(encodeServerSentEvent(event)));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode(": connected\n\n"));
      unsubscribe = hub.subscribe(sessionId, (event) => {
        if (closed || event.eventId <= cursor) return;
        if (!replayComplete || (controller.desiredSize ?? 0) <= 0) {
          replayComplete = false;
          return;
        }
        try {
          enqueue(controller, event);
        } catch {
          close();
        }
      });
      deregisterCloser = registerCloser(close);
      heartbeat = setInterval(() => {
        if (closed || (controller.desiredSize ?? 0) <= 0) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          close();
        }
      }, 15_000);
    },
    pull(controller) {
      try {
        while (!closed && (controller.desiredSize ?? 0) > 0) {
          if (replayBuffer.length === 0 && !replayComplete) {
            replayBuffer = store.eventsAfter(sessionId, cursor, 100);
            if (replayBuffer.length === 0) replayComplete = true;
          }
          const event = replayBuffer.shift();
          if (!event) break;
          enqueue(controller, event);
        }
      } catch (error) {
        closed = true;
        cleanup();
        controller.error(error);
      }
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}

async function readOptionalJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (!request.body || (declaredLength !== null && Number(declaredLength) === 0)) return {};
  return readJson(request);
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ProtocolValidationError("Content-Type must be application/json");
  }
  const maximumBytes = 512 * 1024;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ProtocolValidationError("Request body is too large");
  }
  if (!request.body) throw new ProtocolValidationError("Request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new ProtocolValidationError("Request body is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ProtocolValidationError("Request body must be valid UTF-8");
  }
  return JSON.parse(text) as unknown;
}

function parseEventCursor(queryValue: string | null, headerValue: string | null): number {
  const values = [queryValue, headerValue].filter((value): value is string => value !== null);
  const cursors = values.length > 0 ? values.map(Number) : [0];
  if (cursors.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ProtocolValidationError("Event cursor must be a non-negative integer");
  }
  return Math.max(...cursors);
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const contains = (value: string) => value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith(sep));
  return contains(leftToRight) || contains(rightToLeft);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function apiError(code: string, message: string, status: number): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return json(body, status);
}
