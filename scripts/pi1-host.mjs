// Offline Pi 1.1.0 load/lifecycle + native nested-tool/loadout regression.
// PI1_HOST_PACKAGE may point at the installed host rather than local dev deps.
import assert from 'node:assert/strict';
import test from 'node:test';
import { findPackageJSON } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const scratch = resolve(process.env.PI1_SCRATCH ?? join(repo, '.tmp'));
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, 'pi1-'));
const agentDir = join(root, 'agent');
mkdirSync(agentDir);
mkdirSync(join(root, '.pi'));
process.env.PI_CODING_AGENT_DIR = agentDir;
const host = process.env.PI1_HOST_PACKAGE;
const hostEntry = process.env.PI1_HOST_ENTRY === 'bundle' ? 'dist/bundle/index.js' : 'dist/index.js';
const sdk = await import(host ? pathToFileURL(join(host, hostEntry)).href : '@earendil-works/pi-coding-agent');
const localSdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const localSdk = await import(localSdkUrl);
assert.equal(localSdk.VERSION, "1.1.0", 'resolved development SDK VERSION');
assert.equal(sdk.VERSION, "1.1.0", 'executing host VERSION');
const typeboxPackage = findPackageJSON('typebox', pathToFileURL(join(sdk.getPackageDir(), 'package.json')));
assert.equal(JSON.parse(readFileSync(typeboxPackage, 'utf8')).version, '1.3.27');
const aiPackage = findPackageJSON('@earendil-works/pi-ai/compat', pathToFileURL(join(sdk.getPackageDir(), 'package.json')));
const aiManifest = JSON.parse(readFileSync(aiPackage, 'utf8'));
assert.equal(aiManifest.version, "1.1.0");
const aiUrl = pathToFileURL(join(dirname(aiPackage), aiManifest.exports['./compat'].import)).href;
const ai = await import(aiUrl);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentTools } = ai;

test('1.1.0: load, declarations, native nested validation/results, refresh and shutdown', { timeout: 30000 }, async () => {
  assert.equal(JSON.parse(readFileSync(join(sdk.getPackageDir(), 'package.json'), 'utf8')).version, "1.1.0");
  if (manifest.name === 'pi-namespace') writeFileSync(join(root, '.pi/namespace.json'), JSON.stringify({ builtinNamespace: 'fs', separator: '__' }));
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: ['+codemode'] });
  const faux = fauxProvider({ provider: 'pi1-offline', api: 'pi1-offline-api', models: [{ id: 'test', name: 'Offline test', reasoning: false }], tokenSize: { min: 100, max: 100 } });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const identityPath = join(root, 'identity.ts');
  globalThis[Symbol.for('pi1.host.identity')] = { AgentSession: sdk.AgentSession, Type: ai.Type };
  writeFileSync(identityPath, `import { AgentSession } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { Type as TypeboxType } from 'typebox';
export default function () {
 const expected = globalThis[Symbol.for('pi1.host.identity')];
 if (AgentSession !== expected.AgentSession || Type !== TypeboxType) throw new Error('Duplicate host module identity');
}`);
  const events = [], calls = [], errors = [];
  let api;
  const readName = manifest.name === 'pi-namespace' ? 'fs__read' : 'read';
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [...manifest.pi.extensions.map(p => resolve(repo, p)), identityPath],
    extensionFactories: [sdk.createCodemodeExtension({ mode: 'only', models: false }), pi => {
      api = pi;
      for (const event of ['tool_call', 'tool_result', 'tool_execution_start', 'tool_execution_end', 'session_start', 'session_shutdown', 'provider_stream_event', 'agent_settled']) pi.on(event, e => { events.push(e); });
      pi.on('tool_call', e => {
        if (e.toolName === 'probe_echo' && e.input.value === -1) return { block: true, reason: 'offline-policy-block' };
      });
      pi.registerTool({ name: 'probe_echo', label: 'Echo', description: 'Probe', exposure: 'codemode',
        parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
        outputSchema: { type: 'integer' },
        execute: async (_id, args) => { calls.push(args); return { content: [{ type: 'text', text: String(args.value) }], structuredContent: args.value, details: undefined }; } });
      pi.registerTool({ name: 'fabric_exec', label: 'Fabric contract probe', description: 'Native orchestrator', exposure: 'model-only',
        parameters: { type: 'object', properties: {} },
        prepareLoadout: loadout => ({ hiddenDeclarations: loadout.callable.map(t => t.name) }),
        async execute(_id, _args, signal, _update, ctx) {
          assert(ctx.tools.some(t => t.name === 'probe_echo'));
          assert(!ctx.tools.some(t => t.name === 'fabric_exec'));
          const result = await ctx.executeTool('probe_echo', { value: 7 }, { signal });
          assert.equal(result.isError, false);
          assert.equal(result.result.structuredContent, 7);
          const invalid = await ctx.executeTool('probe_echo', { value: {} }, { signal });
          assert.equal(invalid.isError, true);
          const read = await ctx.executeTool(readName, { path: identityPath }, { signal });
          assert.equal(read.isError, false);
          const blocked = await ctx.executeTool('probe_echo', { value: -1 }, { signal });
          assert.equal(blocked.isError, true, 'nested calls must respect tool_call policy');
          assert.match(JSON.stringify(blocked.result.content), /offline-policy-block/);
          return { content: [{ type: 'text', text: 'nested-ok' }], details: { nested: result.toolCall.id } };
        } });
    }] });
  let session;
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel('pi1-offline', 'test'), resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) }));
    session.extensionRunner.onError(e => errors.push(e));
    const sessionEvents = [];
    session.subscribe(e => { sessionEvents.push(e); });
    await session.bindExtensions({});
    const registered = loader.getExtensions().extensions;
    const owned = registered.find(e => manifest.pi.extensions.some(p => e.resolvedPath === resolve(repo, p)));
    assert(owned, 'manifest entrypoint loaded');
    assert(owned.handlers.size + owned.tools.size + owned.commands.size > 0, 'public registrations present');
    const command = { 'pi-invisible-continue': 'continue', '@monotykamary/pi-retry': 'retry', 'pi-queue-steer-factory': 'pause', 'pi-lazy-extensions': 'ext', 'pi-namespace': 'namespace', 'pi-vision-handoff': 'vision-handoff', '@monotykamary/pi-vcc': 'pi-vcc' }[manifest.name];
    if (command) assert(session.extensionRunner.getRegisteredCommands().some(c => c.name === command), `registered /${command}`);
    assert(session.getActiveToolNames().includes(readName));
    // A dynamic refresh must retain renamed builtins and callable-only exposure.
    api.registerTool({ name: 'late_probe', label: 'Late', description: 'Late', exposure: 'hidden', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: undefined }) });
    assert(session.getActiveToolNames().includes(readName));
    assert(session.getCallableToolNames().includes('probe_echo'));
    assert(!session.getActiveToolNames().includes('probe_echo'));
    assert(!session.getCallableToolNames().includes('late_probe'));
    faux.setResponses([ctx => {
      const names = getCurrentTools(ctx.messages).map(t => t.name);
      assert(names.includes('fabric_exec'));
      assert(!names.includes(readName), 'Fabric/native codemode must hide declarations, not callable tools');
      assert(!names.includes('probe_echo'));
      return fauxAssistantMessage([fauxToolCall('fabric_exec', {}, { id: 'outer' })], { stopReason: 'toolUse' });
    }, fauxAssistantMessage('done')]);
    await session.prompt('offline nested probe');
    assert.equal(session.getLastAssistantText(), 'done');
    assert.deepEqual(calls, [{ value: 7 }]);
    assert(events.some(e => e.type === 'tool_result' && e.parentToolCallId === 'outer' && e.toolCallId === 'outer/1'));
    assert(events.some(e => e.type === 'tool_call' && e.parentToolCallId === 'outer' && e.toolCallId === 'outer/1' && e.input.value === 7), 'nested tool_call preserves parent, id and input');
    assert(events.some(e => e.type === 'tool_call' && e.parentToolCallId === 'outer' && e.input.value === -1), 'blocked calls still forward tool_call');
    assert(events.some(e => e.type === 'tool_execution_end' && typeof e.durationMs === 'number'), '1.1 records final execution duration');
    assert(!session.messages.some(m => m.role === 'toolResult' && m.toolName === 'probe_echo'), 'nested calls do not enter transcript');
    assert(events.some(e => e.type === 'tool_result' && e.toolName === readName && e.parentToolCallId === 'outer'), 'builtin wrappers emit their registered namespace');
    const outer = session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'outer');
    assert(outer?.nestedCalls, 'native nested audit record is retained');
    assert.equal(outer.isError, false, JSON.stringify(outer));
    faux.setResponses([fauxAssistantMessage([fauxToolCall('codemode', { code: 'return await tools.probe_echo({ value: 11 });' }, { id: 'code-outer' })], { stopReason: 'toolUse' }), fauxAssistantMessage('code-done')]);
    await session.prompt('offline native codemode probe');
    const codeResult = session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'code-outer');
    assert.equal(codeResult?.isError, false, JSON.stringify(codeResult));
    assert.deepEqual(calls, [{ value: 7 }, { value: 11 }]);
    assert(events.some(e => e.type === 'tool_result' && e.parentToolCallId === 'code-outer'));
    if (manifest.name === 'pi-invisible-continue') {
      const users = session.messages.filter(m => m.role === 'user').length;
      faux.setResponses([ctx => { assert(!JSON.stringify(ctx.messages).includes('pi-invisible-continue:resume')); return fauxAssistantMessage('continued'); }]);
      await session.prompt('/continue');
      await session.waitForIdle();
      assert.equal(session.getLastAssistantText(), 'continued');
      assert.equal(session.messages.filter(m => m.role === 'user').length, users);
    }
    const beforeCompactionCalls = faux.state.callCount;
    settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 } });
    const compacted = await session.compact('__pi_vcc__');
    assert(compacted.summary.length > 0);
    assert.equal(faux.state.callCount, beforeCompactionCalls, 'VCC compaction is algorithmic, never a model call');
    const checkpoint = session.sessionManager.getBranch().findLast(e => e.type === 'compaction');
    assert(checkpoint?.fromHook);
    assert(checkpoint.systemMessage, 'Pi owns the system/tool checkpoint');
    faux.setResponses([context => { assert(getCurrentTools(context.messages).some(t => t.name === 'codemode')); return fauxAssistantMessage('after-compact'); }]);
    await session.prompt('continue after compaction');
    assert.equal(session.getLastAssistantText(), 'after-compact');
    const usersBeforeResume = session.messages.filter(m => m.role === 'user').length;
    faux.setResponses([context => {
      assert(!JSON.stringify(context.messages).includes('pi-vcc:resume-after-compaction'));
      assert(getCurrentTools(context.messages).some(t => t.name === 'codemode'));
      return fauxAssistantMessage('invisibly resumed after checkpoint');
    }]);
    api.sendMessage({ customType: 'pi-vcc:resume-after-compaction', content: [], display: false, details: undefined }, { triggerTurn: true, deliverAs: 'followUp' });
    await session.waitForIdle();
    assert.equal(session.getLastAssistantText(), 'invisibly resumed after checkpoint');
    assert.equal(session.messages.filter(m => m.role === 'user').length, usersBeforeResume);
    // VCC must leave compilation to the selected Fabric owner, even when VCC
    // is dispatched first. This exercises real native hook composition, not
    // direct invocation of the VCC callback or a live summarization request.
    const previousEngine = process.env.PI_FABRIC_COMPACTION_ENGINE;
    process.env.PI_FABRIC_COMPACTION_ENGINE = 'fabric';
    let fabricClaims = 0;
    const removeFabricOwner = api.on('session_before_compact', event => {
      if (event.customInstructions === '__pi_vcc__') return;
      assert.equal(event._piVccOverriding, undefined, 'VCC did not claim Fabric compaction');
      event._fabricCompaction = true;
      fabricClaims++;
      return { compaction: {
        summary: 'Offline Fabric-owned checkpoint',
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { compactor: 'fabric-contract-probe' },
      } };
    });
    try {
      const callsBeforeFabric = faux.state.callCount;
      const delegated = await session.compact('offline Fabric ownership');
      assert.equal(delegated.summary, 'Offline Fabric-owned checkpoint');
      assert.equal(fabricClaims, 1);
      assert.equal(faux.state.callCount, callsBeforeFabric);
      assert.equal(session.sessionManager.getBranch().findLast(e => e.type === 'compaction')?.details?.compactor, 'fabric-contract-probe');
      // Pi refuses repeated compaction without new context, and VCC needs
      // more than two live messages. Add two ordinary offline turns before
      // testing the explicit override of the Fabric owner.
      faux.setResponses([
        fauxAssistantMessage('fresh work before explicit VCC compaction'),
        fauxAssistantMessage('more work with a summarizable earlier turn'),
      ]);
      await session.prompt('new work for explicit VCC ownership');
      await session.prompt('second turn before explicit VCC ownership');
      const explicit = await session.compact('__pi_vcc__');
      assert(explicit.summary.length > 0);
      assert.equal(fabricClaims, 1, 'explicit /pi-vcc remains VCC-owned');
      assert.equal(session.sessionManager.getBranch().findLast(e => e.type === 'compaction')?.details?.compactor, 'pi-vcc');
      assert.equal(faux.state.callCount, callsBeforeFabric + 2, 'only fresh user turns call the provider, never either compiler');
    } finally {
      removeFabricOwner();
      if (previousEngine === undefined) delete process.env.PI_FABRIC_COMPACTION_ENGINE;
      else process.env.PI_FABRIC_COMPACTION_ENGINE = previousEngine;
    }
    // Raw provider callbacks are awaited in order before normalized content.
    // Faux does not emit them itself: its response factory simulates a native
    // provider's parsed data through the actual SDK-supplied stream options.
    const rawData = [{ type: 'pi110-raw', ordinal: 1 }, { type: 'pi110-raw', ordinal: 2 }];
    faux.setResponses([async (_context, options, _state, model) => {
      assert.equal(typeof options.onProviderStreamEvent, 'function');
      for (const data of rawData) await options.onProviderStreamEvent(data, model);
      return fauxAssistantMessage('raw-stream-complete');
    }]);
    await session.prompt('offline raw-stream probe');
    const rawEvents = events.filter(e => e.type === 'provider_stream_event');
    assert.deepEqual(rawEvents.map(e => e.data), rawData);
    assert(rawEvents.every(e => e.provider === 'pi1-offline' && e.api === 'pi1-offline-api' && e.model === 'test'));
    assert.equal(session.getLastAssistantText(), 'raw-stream-complete');
    assert(!JSON.stringify(session.sessionManager.getEntries()).includes('pi110-raw'), 'raw events are notification-only');
    assert.equal(events.filter(e => e.type === 'agent_settled').at(-1)?.aborted, false);
    assert.equal(sessionEvents.filter(e => e.type === 'agent_settled').at(-1)?.aborted, false);

    // Cancel an active request, not a synthetic event. Abort must settle once,
    // never retry/compact, and the next run must clear the cancellation flag.
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    faux.setResponses([async (_context, options) => {
      entered();
      await new Promise(resolve => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener('abort', resolve, { once: true });
      });
      return fauxAssistantMessage('cancelled');
    }]);
    const beforeAbort = events.filter(e => e.type === 'agent_settled').length;
    const active = session.prompt('offline cancellation probe');
    await ready;
    const callsAtAbort = faux.state.callCount;
    await session.abort();
    await active;
    await session.waitForIdle();
    assert.equal(faux.state.callCount, callsAtAbort, 'cancellation never retries');
    assert.equal(events.filter(e => e.type === 'agent_settled').length, beforeAbort + 1);
    assert.equal(events.filter(e => e.type === 'agent_settled').at(-1)?.aborted, true);
    assert.equal(sessionEvents.filter(e => e.type === 'agent_settled').at(-1)?.aborted, true);
    faux.setResponses([fauxAssistantMessage('after-abort')]);
    await session.prompt('offline run after cancellation');
    assert.equal(session.getLastAssistantText(), 'after-abort');
    assert.equal(events.filter(e => e.type === 'agent_settled').at(-1)?.aborted, false);
    assert.equal(sessionEvents.filter(e => e.type === 'agent_settled').at(-1)?.aborted, false);

    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
    assert(events.some(e => e.type === 'session_shutdown'));
    assert.deepEqual(errors, []);
    session.dispose();
    assert.throws(() => api.getActiveTools(), /stale|inactive|invalid/i);
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel('pi1-offline', 'test'), resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) }));
    await session.bindExtensions({});
    assert(session.getActiveToolNames().includes(readName), 'reload preserves the loadout');
    assert(!session.getActiveToolNames().includes('probe_echo'));
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    console.log(JSON.stringify({ repo: manifest.name, pi: sdk.VERSION, hostEntry, localSdkUrl, registrations: { handlers: owned.handlers.size, commands: owned.commands.size, tools: owned.tools.size }, nestedCalls: calls.length }));
  } finally {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
