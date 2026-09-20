import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_EXECUTION_RECEIPT_PROTOCOL,
  LocalDesktopCommanderClient,
} from '../dist/local-execution-client.js';

class FakeBackend {
  constructor({ readyError = null, callError = null, result = { content: [{ type: 'text', text: 'ok' }] } } = {}) {
    this.readyError = readyError;
    this.callError = callError;
    this.result = result;
    this.ensureReadyCalls = 0;
    this.callCalls = 0;
    this.listCalls = 0;
    this.shutdownCalls = 0;
    this.lastCall = null;
  }

  async ensureReady() {
    this.ensureReadyCalls += 1;
    if (this.readyError) throw this.readyError;
  }

  async listClientTools() {
    this.listCalls += 1;
    return { tools: [{ name: 'list_processes' }] };
  }

  async callClientTool(toolName, args, metadata) {
    this.callCalls += 1;
    this.lastCall = { toolName, args, metadata };
    if (this.callError) throw this.callError;
    return this.result;
  }

  async shutdown() {
    this.shutdownCalls += 1;
  }
}

async function testSuccessReceipt() {
  const backend = new FakeBackend({
    result: { content: [{ type: 'text', text: 'sensitive-result-body' }], structuredContent: { count: 1 } },
  });
  const client = new LocalDesktopCommanderClient({
    backend,
    policy: { allowedTools: ['list_processes'] },
  });

  const outcome = await client.execute({
    callId: 'call-success-001',
    toolName: 'list_processes',
    args: { query: 'sensitive-argument-body' },
    metadata: { mission_id: 'mission-001' },
  });

  assert.equal(outcome.receipt.protocol, LOCAL_EXECUTION_RECEIPT_PROTOCOL);
  assert.equal(outcome.receipt.status, 'COMPLETED');
  assert.equal(outcome.receipt.automatic_retry_safe, false);
  assert.equal(outcome.receipt.execution_only, true);
  assert.equal(outcome.receipt.mission_authority, false);
  assert.equal(outcome.receipt.raw_arguments_retained, false);
  assert.equal(outcome.receipt.raw_result_retained, false);
  assert.match(outcome.receipt.arguments_sha256, /^[a-f0-9]{64}$/);
  assert.match(outcome.receipt.result_sha256, /^[a-f0-9]{64}$/);
  assert.equal(backend.ensureReadyCalls, 1);
  assert.equal(backend.callCalls, 1);
  assert.equal(backend.lastCall.metadata.remote, false);
  assert.equal(backend.lastCall.metadata.execution_plane, 'local');
  assert.equal(backend.lastCall.metadata.call_id, 'call-success-001');
  const durable = JSON.stringify(outcome.receipt);
  assert.equal(durable.includes('sensitive-argument-body'), false);
  assert.equal(durable.includes('sensitive-result-body'), false);
  assert.equal(outcome.result.content[0].text, 'sensitive-result-body');
}

async function testPolicyDenied() {
  const backend = new FakeBackend();
  const client = new LocalDesktopCommanderClient({
    backend,
    policy: { allowedTools: ['read_file'] },
  });
  const outcome = await client.execute({
    callId: 'call-policy-001',
    toolName: 'start_process',
    args: { command: 'echo test' },
  });
  assert.equal(outcome.receipt.status, 'POLICY_DENIED');
  assert.equal(outcome.receipt.automatic_retry_safe, false);
  assert.equal(backend.ensureReadyCalls, 0);
  assert.equal(backend.callCalls, 0);
}

async function testNotDispatched() {
  const backend = new FakeBackend({ readyError: new Error('child unavailable') });
  const client = new LocalDesktopCommanderClient({ backend });
  const outcome = await client.execute({
    callId: 'call-not-dispatched-001',
    toolName: 'list_processes',
  });
  assert.equal(outcome.receipt.status, 'NOT_DISPATCHED');
  assert.equal(outcome.receipt.automatic_retry_safe, true);
  assert.equal(backend.callCalls, 0);
  assert.match(outcome.receipt.error_message_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(outcome.receipt).includes('child unavailable'), false);
}

async function testOutcomeUnknown() {
  const backend = new FakeBackend({ callError: new Error('stdio closed after dispatch') });
  const client = new LocalDesktopCommanderClient({ backend });
  const outcome = await client.execute({
    callId: 'call-unknown-001',
    toolName: 'start_process',
    args: { command: 'echo maybe-ran' },
  });
  assert.equal(outcome.receipt.status, 'OUTCOME_UNKNOWN');
  assert.equal(outcome.receipt.automatic_retry_safe, false);
  assert.equal(backend.ensureReadyCalls, 1);
  assert.equal(backend.callCalls, 1);
  assert.equal(JSON.stringify(outcome.receipt).includes('stdio closed after dispatch'), false);
}

async function testServerReportedFailure() {
  const backend = new FakeBackend({
    result: { isError: true, content: [{ type: 'text', text: 'Command not allowed' }] },
  });
  const client = new LocalDesktopCommanderClient({ backend });
  const outcome = await client.execute({
    callId: 'call-failed-001',
    toolName: 'start_process',
    args: { command: 'blocked-command' },
  });
  assert.equal(outcome.receipt.status, 'FAILED');
  assert.equal(outcome.receipt.automatic_retry_safe, false);
  assert.match(outcome.receipt.result_sha256, /^[a-f0-9]{64}$/);
}

async function testListAndShutdown() {
  const backend = new FakeBackend();
  const client = new LocalDesktopCommanderClient({ backend });
  const tools = await client.listTools();
  assert.equal(backend.ensureReadyCalls, 1);
  assert.equal(backend.listCalls, 1);
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['list_processes']);
  await client.shutdown();
  assert.equal(backend.shutdownCalls, 1);
}

export default async function runTests() {
  await testSuccessReceipt();
  await testPolicyDenied();
  await testNotDispatched();
  await testOutcomeUnknown();
  await testServerReportedFailure();
  await testListAndShutdown();
  console.log('Local execution client tests passed');
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runTests().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
