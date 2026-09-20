# Local Desktop Commander Execution Client

Status: candidate extension in `46slv/desktopcommandermcp`
Updated: 2026-09-21

## Purpose

Expose Desktop Commander's existing local stdio MCP child as a reusable execution-plane client without using the hosted Remote MCP / Supabase device channel.

This is intended for local orchestrators such as EPHEMERA-System, Codex harnesses, or other machine-local control planes that already own task/Mission state and only need Desktop Commander's terminal/filesystem/process capabilities.

## Boundary

```text
Mission / task owner
  owns authority, claims, dedupe, retry, state transitions
        |
        v
LocalDesktopCommanderClient
  execution facade only
        |
        v
DesktopCommanderIntegration
  supervises local MCP child
        |
        v
Desktop Commander MCP
  terminal / files / process / search / edit
```

The client does not import or initialize `RemoteChannel`, Supabase, remote device authentication, or hosted Desktop Commander routing.

## API

Build the repository, then import:

```js
import { LocalDesktopCommanderClient } from "./dist/local-execution-client.js";

const client = new LocalDesktopCommanderClient({
  policy: {
    allowedTools: ["read_file", "list_directory", "start_process"]
  }
});

const outcome = await client.execute({
  callId: "mission-run-call-001",
  toolName: "read_file",
  args: { path: "C:/work/example.txt" }
});
```

The adapter forces MCP call metadata `remote:false` and `execution_plane:"local"`.

## Receipt contract

Each call returns an ephemeral result plus a bounded receipt:

```text
desktop-commander.local-execution-receipt / v1
```

The receipt contains:

- caller-owned `call_id`
- tool name
- local stdio transport identity
- execution status
- timestamps/duration
- SHA-256 of arguments
- SHA-256/byte count of a returned result
- hashed error message when present
- explicit authority/retry/privacy boundaries

It never retains raw arguments or raw result bytes.

## Outcome semantics

```text
COMPLETED
  tool returned normally

FAILED
  MCP returned a definite isError result

NOT_DISPATCHED
  local MCP child could not be made ready before dispatch
  automatic_retry_safe = true

OUTCOME_UNKNOWN
  callClientTool threw after dispatch could have begun
  automatic_retry_safe = false

POLICY_DENIED
  local per-client allowlist rejected the tool before dispatch
  automatic_retry_safe = false
```

`OUTCOME_UNKNOWN` is deliberately not converted into FAILED. A process/file mutation may have happened before an MCP/stdio failure became visible. The owning control plane must reconcile live state before deciding whether to retry.

## Authority

The client is execution-only:

- `execution_only = true`
- `mission_authority = false`
- no task/Goal selection
- no Mission checkpoint ownership
- no durable dedupe claim ownership
- no automatic retry after dispatch ambiguity

A higher-level owner such as EPHEMERA-System should persist a durable claim before invoking a side-effecting tool, then correlate the returned receipt.

## Policy

The client supports a process-local `allowedTools` allowlist. Desktop Commander's existing global `blockedCommands` and `allowedDirectories` remain an additional coarse safety layer.

Do not rewrite Desktop Commander's global config per Mission. Mission-specific scope belongs to the owning orchestrator/adapter.

## EPHEMERA fit

Recommended topology:

```text
ChatGPT
  -> Goal / REPORT / CONSULT only

EPHEMERA-System
  -> Mission authority / checkpoint / recovery
  -> durable execution claim
  -> LocalDesktopCommanderClient
  -> execution receipt
  -> reconcile result/evidence
```

This avoids using hosted Remote Desktop Commander tool calls for high-volume local machine work. Hosted Remote MCP can remain available as an operator/emergency direct-control lane.

## Verification

Candidate smoke on SHIRO-WS:

- build: PASS
- fake-backend receipt/policy/ambiguity tests: PASS
- local stdio child launched from the candidate build
- tool discovery: 26 tools
- read-only `list_processes`: COMPLETED
- local child shutdown: clean
- hosted Remote MCP not used by the smoke execution path

The repository's upstream `main` remains unchanged; this capability should stay on an isolated feature branch until reviewed.
