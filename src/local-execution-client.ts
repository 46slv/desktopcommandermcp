import { createHash } from 'node:crypto';

import { DesktopCommanderIntegration } from './remote-device/desktop-commander-integration.js';

export const LOCAL_EXECUTION_RECEIPT_PROTOCOL = 'desktop-commander.local-execution-receipt';
export const LOCAL_EXECUTION_RECEIPT_SCHEMA_VERSION = 1;

export type LocalExecutionStatus =
  | 'COMPLETED'
  | 'FAILED'
  | 'NOT_DISPATCHED'
  | 'OUTCOME_UNKNOWN'
  | 'POLICY_DENIED';

export interface LocalDesktopCommanderBackend {
  ensureReady(): Promise<void>;
  listClientTools(): Promise<{ tools: any[] }>;
  callClientTool(toolName: string, args: any, metadata?: any): Promise<any>;
  shutdown(): Promise<void>;
}

export interface LocalExecutionPolicy {
  allowedTools?: readonly string[];
}

export interface LocalExecutionRequest {
  callId: string;
  toolName: string;
  args?: unknown;
  metadata?: Record<string, unknown>;
}

export interface LocalExecutionReceipt {
  protocol: typeof LOCAL_EXECUTION_RECEIPT_PROTOCOL;
  schema_version: typeof LOCAL_EXECUTION_RECEIPT_SCHEMA_VERSION;
  call_id: string;
  tool_name: string;
  transport: 'local-stdio-mcp';
  status: LocalExecutionStatus;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  arguments_sha256: string;
  result_sha256: string | null;
  result_bytes: number | null;
  error_name: string | null;
  error_message_sha256: string | null;
  automatic_retry_safe: boolean;
  execution_only: true;
  mission_authority: false;
  raw_arguments_retained: false;
  raw_result_retained: false;
}

export interface LocalExecutionOutcome {
  result: any | null;
  receipt: LocalExecutionReceipt;
  error: { name: string; message: string } | null;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Only finite numbers are admissible');
    return JSON.stringify(value);
  }
  if (value === undefined) return '"[undefined]"';
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (seen.has(value)) throw new Error('Cyclic input is not admissible');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((entry) => canonical(entry, seen)).join(',')}]`
    : `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`)
      .join(',')}}`;
  seen.delete(value);
  return result;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(canonical(value), 'utf8');
}

function normalizeId(value: string, field: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function normalizeToolName(value: string): string {
  if (typeof value !== 'string' || !TOOL_RE.test(value)) throw new Error('toolName is invalid');
  return value;
}

function errorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name || 'Error', message: error.message || 'Unknown error' };
  return { name: 'Error', message: String(error) };
}

function buildReceipt({
  request,
  status,
  startedAt,
  completedAt,
  result,
  error,
}: {
  request: Required<Pick<LocalExecutionRequest, 'callId' | 'toolName'>> & { args: unknown };
  status: LocalExecutionStatus;
  startedAt: string;
  completedAt: string;
  result: any | null;
  error: { name: string; message: string } | null;
}): LocalExecutionReceipt {
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  return Object.freeze({
    protocol: LOCAL_EXECUTION_RECEIPT_PROTOCOL,
    schema_version: LOCAL_EXECUTION_RECEIPT_SCHEMA_VERSION,
    call_id: request.callId,
    tool_name: request.toolName,
    transport: 'local-stdio-mcp',
    status,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    arguments_sha256: digest(request.args),
    result_sha256: result === null ? null : digest(result),
    result_bytes: result === null ? null : byteLength(result),
    error_name: error?.name ?? null,
    error_message_sha256: error ? digest(error.message) : null,
    automatic_retry_safe: status === 'NOT_DISPATCHED',
    execution_only: true,
    mission_authority: false,
    raw_arguments_retained: false,
    raw_result_retained: false,
  });
}

/**
 * Local/headless Desktop Commander execution facade.
 *
 * It intentionally excludes RemoteChannel/Supabase/device auth. The caller owns
 * Mission state, durable execution claims/dedupe and retry decisions.
 */
export class LocalDesktopCommanderClient {
  private readonly backend: LocalDesktopCommanderBackend;
  private readonly allowedTools: Set<string> | null;

  constructor({
    backend = new DesktopCommanderIntegration(),
    policy = {},
  }: {
    backend?: LocalDesktopCommanderBackend;
    policy?: LocalExecutionPolicy;
  } = {}) {
    this.backend = backend;
    this.allowedTools = policy.allowedTools ? new Set(policy.allowedTools.map(normalizeToolName)) : null;
  }

  async connect(): Promise<void> {
    await this.backend.ensureReady();
  }

  async listTools(): Promise<{ tools: any[] }> {
    await this.backend.ensureReady();
    return this.backend.listClientTools();
  }

  async execute(request: LocalExecutionRequest): Promise<LocalExecutionOutcome> {
    const callId = normalizeId(request.callId, 'callId');
    const toolName = normalizeToolName(request.toolName);
    const args = request.args ?? {};
    // Validate/digest before anything can be dispatched.
    digest(args);

    const normalizedRequest = { callId, toolName, args };
    const startedAt = new Date().toISOString();

    if (this.allowedTools && !this.allowedTools.has(toolName)) {
      const completedAt = new Date().toISOString();
      const error = { name: 'PolicyDenied', message: `Tool is outside the local execution allowlist: ${toolName}` };
      return {
        result: null,
        error,
        receipt: buildReceipt({
          request: normalizedRequest,
          status: 'POLICY_DENIED',
          startedAt,
          completedAt,
          result: null,
          error,
        }),
      };
    }

    try {
      // A failure here is proven pre-dispatch and may be retried by the owner.
      await this.backend.ensureReady();
    } catch (caught) {
      const completedAt = new Date().toISOString();
      const error = errorSummary(caught);
      return {
        result: null,
        error,
        receipt: buildReceipt({
          request: normalizedRequest,
          status: 'NOT_DISPATCHED',
          startedAt,
          completedAt,
          result: null,
          error,
        }),
      };
    }

    try {
      const result = await this.backend.callClientTool(toolName, args, {
        remote: false,
        execution_plane: 'local',
        call_id: callId,
        ...(request.metadata ?? {}),
      });
      const completedAt = new Date().toISOString();
      const failed = result?.isError === true;
      return {
        result,
        error: null,
        receipt: buildReceipt({
          request: normalizedRequest,
          status: failed ? 'FAILED' : 'COMPLETED',
          startedAt,
          completedAt,
          result,
          error: null,
        }),
      };
    } catch (caught) {
      // Once callClientTool was entered we cannot prove whether a side effect
      // happened before the stdio/MCP failure. Preserve ambiguity; never imply
      // that automatic retry is safe.
      const completedAt = new Date().toISOString();
      const error = errorSummary(caught);
      return {
        result: null,
        error,
        receipt: buildReceipt({
          request: normalizedRequest,
          status: 'OUTCOME_UNKNOWN',
          startedAt,
          completedAt,
          result: null,
          error,
        }),
      };
    }
  }

  async shutdown(): Promise<void> {
    await this.backend.shutdown();
  }
}
