import { effortCapability, validateEffort } from './model-effort.js';
/**
 * The agent loop: send the transcript, run whatever tools come back, repeat
 * until the model stops asking for tools.
 *
 * The loop is provider-agnostic. It reads `session.model` fresh on every step,
 * so a model swapped in the middle of a session takes effect on the next step
 * with the whole history intact.
 */

import crypto from 'node:crypto';
import { toBase64, toDataUrl } from './attachments.js';
import { clientFor, providerFor } from './providers/index.js';
import { runTool } from './tools.js';
import { assistantEvent, noteEvent, toolResultEvent, userEvent } from './transcript.js';


/**
 * Run a tool, but never wait on it forever.
 *
 * Some calls block in ways nothing here can cancel - a macOS consent dialog for
 * ~/Documents blocks readdir until somebody clicks it, and if the laptop lid is
 * shut nobody can. Without this the whole turn wedges and Stop does nothing,
 * because the loop only checks the abort signal between tools.
 *
 * The underlying operation cannot truly be cancelled; what changes is that the
 * harness stops waiting on it, reports why, and stays responsive.
 */
async function boundedTool(call, ctx, { signal, ms }) {
  let timer;
  let onAbort;
  const controller = new AbortController();
  const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    return await Promise.race([
      runTool(call, {...ctx, signal:cancellation}),
      new Promise((resolve) => {
        timer = setTimeout(
          () => { controller.abort(); resolve({ ok: false, output: `timed out after ${Math.round(ms / 1000)}s — the tool did not return. If it touched ~/Documents, ~/Downloads or ~/Desktop, macOS may be waiting on a permission dialog. Cancellation was requested; external effects may already have occurred.` }); },
          ms,
        );
      }),
      new Promise((resolve) => {
        if (signal?.aborted) return resolve({ ok: false, output: 'stopped by user' });
        onAbort = () => resolve({ ok: false, output: 'stopped by user' });
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

const BASE_SYSTEM = `You are a capable assistant working with the user. You have tools to list, read, write and edit files, and to run shell commands in a project directory. You are not limited to coding: answer whatever the user actually asks.

Answering:
- If you can answer from your own knowledge, just answer, in your message. Do not run a command to produce an answer, and never use the shell to speak to the user - echo is not how you reply.
- Reach for a tool when the task genuinely needs the machine: reading or changing files, running builds or tests, inspecting the system.
- After a tool runs, say what it means in your own words. The user usually has tool output collapsed, so a tool call with no explanation reads as no answer at all.
- If the request is a plain question, a plain answer is the whole job. Do not invent project work around it.

Working on the project:
- The project directory is the working directory for every tool call. Use paths relative to it.
- Look before you leap: list_dir and read_file before editing something you have not seen.
- Prefer edit_file over write_file when changing part of an existing file.
- After making changes, verify them - run the tests, the build, or the program itself.
- If a command fails, read the error and fix it rather than reporting the failure back verbatim.

Serving an app the user can open from their phone:
- For generated documents and other downloadable files, link the absolute file path in Markdown so Harness serves it through its existing file preview and download controls. Do not start a temporary web server just to deliver a file. A localhost link only works on the hosting laptop, never on the phone.
- The harness itself runs on port 8787 and owns its Tailscale hostname on ports 80, 443 and 8787. Never take those over, never point a tailscale serve rule at them, and never bind 8787. The user needs the harness reachable at all times, including while your app is running.
- Give your app its own port and its own Tailscale entry, choosing a port nothing else is using. For example, to expose a server on port 4320:
    tailscale serve --bg --https=8443 http://127.0.0.1:4320
  Use the installed Tailscale client. Respect explicit ORCHESTRATOR_TAILSCALE_BIN and ORCHESTRATOR_TAILSCALE_SOCKET overrides; never assume a custom daemon. The orchestrator’s own phone route is managed through Settings → Phone access.
- Tell the user BOTH addresses once it is up, and say which is which:
    phone / away from home:  https://TAILNET_HOST:8443
    the laptop itself:       http://127.0.0.1:4320
  Both are needed. Loopback works on the host even when a custom userspace Tailscale daemon cannot resolve its own tailnet hostname.
- Leave the app running in the background so it stays reachable after your turn ends.
- Do not narrate routine tool calls blow by blow, but always finish with the outcome.
- Follow the user’s intent: perform authorized work, answer questions directly, or ask for missing information when needed. State what changed and how it was verified when you made changes. A clarification question is a valid turn outcome; never invent a completion summary or claim unfinished work is done.`;

const CHAT_SYSTEM = `You are a helpful assistant talking with the user. Answer what they ask, directly and accurately. You have no tools in this conversation, so do not offer to run commands or edit files - if something genuinely needs the machine, say so and suggest they switch this session to agent mode.`;

/** A session in chat mode carries none of the agent scaffolding. */
export const usesTools = (session) => session?.mode !== 'chat';

/**
 * What a harness-editing session needs to work like a careful maintainer rather
 * than guess. A fresh session has none of the context this codebase's usual
 * editor carries, which is why unguided edits come out misplaced and untested.
 */
const HARNESS_GUIDE = [
  "How this harness is built, and how to change it well:",
  "",
  "Layout:",
  "- server/index.js is the HTTP server and all /api routes.",
  "- server/public/index.html, app.js and styles.css are the one UI, used on both phone and desktop. app.js renders every screen; there is no framework and no build step.",
  "- src/core/ is the engine: agent.js (the turn loop and this system prompt), tools.js, providers/, apps.js, git.js, store.js, transcript.js, notify.js.",
  "- test/e2e/ holds a small set of real-server end-to-end workflows, run with: npm test",
  "",
  "Design system (match it exactly, or new UI looks bolted on):",
  "- Dark theme only. Never introduce light backgrounds. Use the existing CSS custom properties (--bg, --bg-2, --bg-3, --fg, --fg-dim, --fg-faint, --line, --accent), never hard-coded colors.",
  "- Reuse existing classes and patterns. A control in the composer copies the existing composer buttons (class attach-btn); a settings control copies the rows already in the settings sheet; a list row uses class item. Put a new control where similar controls already live, at the same size, not wedged in on its own.",
  "- Tap targets are at least 44px. Text stays readable at phone width; nothing may cause horizontal scroll.",
  "",
  "Working discipline:",
  "- For Harness experience or reliability reviews, read GET /api/diagnostics?action=all on the local Harness origin. This combines recent metadata from reachable hosts without replication. Use action=events&host=<host-id>&before=<ISO-time> to page older history; never read the protected data directory. A refused request, missing events or an unreachable host are missing evidence, not proof of user behavior.",
  "- This repository is public and ships only the app: code, tests and user docs. Reports, audits, reviews, handoffs, dossiers, plans, prompts and other working notes never go in it. Keep them in .do-notes/ in this project folder, which Git ignores, and link the user there. Never add real hostnames, personal paths, account names or keys to the repository.",
  "- Read the neighbouring code before adding to it; match its style, naming and structure.",
  "- Run npm test before you finish and report the result. Extend the relevant E2E workflow for behavior changes; do not add unit or source-inspection tests.",
  "- Your changes run on this computer as soon as your turn ends, before any Push: interface files swap in and open pages reload, and server changes make DO restart itself once nothing is running. Do not ask the user to restart or push to see them. They stay on this computer until the user presses Push. If DO reports that they failed to load, fix what it reports. They cannot load mid-turn, so never claim a change works when you could not load it. Dependency changes, server/boot.js and scripts/ only take effect after a Push.",
  "- Versions: every Push of DO adds 0.01 automatically (v1.03 to v1.04), so do not edit VERSION. If the change is a notable new capability, write the word minor to .harness-next-version (v1.03 to v1.1); for a major rework, write major (v1.03 to v2.0).",
  "- The harness data directory (secrets, tokens, the session store, other projects) is off-limits: reads and writes there are refused. Do not try to read secrets.",
].join('\n');

const PROJECT_TRACING = [
  'Tracing for future AI work — applies to every project:',
  '- When building or changing a program, include diagnostic tracing that lets a future coding assistant reconstruct how the user used it. These logs are for the assistant, not a debug interface the user has to read.',
  '- Trace meaningful user actions and navigation, the screen or state actually shown (including loading, empty, success and error states), and the requests or background jobs those actions triggered. Include timestamps, app version, correlation IDs, relevant host, durations, outcomes and failures. Connect browser actions to server work where applicable; server success alone does not prove the user saw success.',
  '- Use structured, searchable logs with bounded size and retention. Reuse existing logging where possible, keep it lightweight, and ensure logging failures never break the app. Keep logs out of Git. Do not record secrets, credentials, raw private content, keystrokes or screenshots by default; use redacted summaries and identifiers.',
  '- Document where traces live, how to read them within the project permissions, and how to reproduce a flow. When the user describes a problem or asks for a change, inspect the relevant recent traces before guessing. Distinguish recorded events from assumptions about what the user saw or felt; say when evidence is missing.',
  '- Verify tracing with a representative user flow, including an error path, so another assistant can follow action → visible result → underlying cause. Keep the normal interface simple; do not make the user collect or interpret routine debugging logs.',
].join('\n');

export function systemPromptFor(session, tailnetHost = null, native = false) {
  if (!usesTools(session)) {
    return session.system?.trim() ? `${CHAT_SYSTEM}\n\n${session.system.trim()}` : CHAT_SYSTEM;
  }

  // The machine's own tailnet name is substituted here rather than written
  // into the source: it is this user's infrastructure, not part of the tool.
  const base = BASE_SYSTEM.replace(/TAILNET_HOST/g, tailnetHost ?? '<this machine>.ts.net');
  const parts = [base, ...(native ? ['Use your native tools, planning and clarification behavior. Native permission requests and AskUserQuestion are relayed through DO to the user; use them when needed.'] : []), PROJECT_TRACING, `\nProject directory: ${session.tabWorkspace?.cwd ?? session.tabWorkspace?.dir ?? session.projectDir}`,
    process.platform === 'win32' && !native ? 'Execution host: native Windows. Shell commands use cmd.exe; use Windows paths and commands, or invoke PowerShell explicitly. Do not assume WSL or Unix tools.' : `Execution host: ${process.platform}.`];
  if (session.tabWorkspace) parts.push('This tab has an isolated Git worktree. Work only in the project directory above, even if older messages name a different directory. Do not switch branches, push, or edit the shared checkout or other worktrees. Install dependencies locally when needed. Changes stay in this tab until the user presses Push in the frontend. That operation fetches remote changes, merges, runs integration checks, and publishes. Never push automatically after a turn. If integration reports a conflict, resolve it here in a subsequent turn. Changes are not live until integration succeeds.');
  if (session.appId && session.appId !== '__harness') parts.push(`When this app itself uses AI at runtime, record its dependency via PATCH /api/apps/${session.appId} with aiDependencies: [{host, alias, label, purpose}]. Discover exact host IDs and source aliases via /api/cluster/status and /api/cluster/sources catalog. Preserve existing dependencies when updating. Record only sources actually configured in the app, never the coding assistant merely building it. Do not put credentials in metadata. Implement runtime model selection by reading HARNESS_APP_AI (JSON array of purpose, provider, model, alias, host) provided at app launch. Support only provider adapters actually implemented; reject unsupported replacements with an actionable error. Document AI requirements and how to use personal credentials in README.md. Never claim metadata alone changes a hard-coded integration. Explain if registration is unavailable.`);
  if (session.editsHarness) {
    // This is a session of the built-in Harness app: it is meant to edit the
    // harness itself. Do not tell it the harness is read-only — it is not, for
    // this session.
    parts.push('\nYou ARE the harness. This session edits the harness\'s own source code (the project directory is the harness itself), which is exactly your job here — treat requests to change the harness as ordinary work, not something forbidden.');
    parts.push(HARNESS_GUIDE);
  } else {
    parts.push('\nYou run inside a harness. The harness\'s own files are read-only to you: you may look at them, but any attempt to write there is refused, and that is deliberate rather than a fault to work around.');
  }
  if (!native) parts.push('You can email the user with send_email when something needs them and they may not be watching — a long run finished, a decision is needed, or work failed in a way you cannot resolve. Do not email for routine progress.');
  if (session.confineToProjectDir) {
    parts.push(native ? 'This project folder is the default scope. If the user’s task needs additional folders or host actions, request the required native permission; do not claim the task is impossible merely because it needs broader scope.' : 'File tools are confined to this directory; paths outside it are refused.');
    parts.push('This session is its own project. Other work on this machine is not yours to read or reason about, even if you can see it — do not go looking through other directories for context, and do not assume another project\'s files are related to this one. If you need something from elsewhere, ask.');
    if (session.readableDirs?.length) {
      parts.push(`You may also READ from these folders, but not write to them:\n${
        session.readableDirs.map((d) => `- ${d}`).join('\n')}`);
    }
  }
  if (session.system?.trim()) {
    parts.push(`\nProject-specific instructions from the user:\n${session.system.trim()}`);
  }
  return parts.join('\n');
}

/**
 * Run one user turn to completion.
 *
 * @param onEvent  called with each event appended to the transcript (already saved)
 * @param onDelta  called with live streaming updates that are not persisted
 * @param save     persists the session; awaited after every appended event
 */
// Native agents own their stopping and clarification behavior. Never manufacture
// a final answer with a second, tool-free model call.
export async function runTurn(opts) {
  const result = await runTurnInner(opts);
  opts.onOutcome?.(result?.outcome || (opts.signal?.aborted ? 'cancelled' : 'responded'));
  return result;
}

async function runTurnInner({
  session, models, userText, attachments, onEvent, onDelta, save, signal,
  tailnetHost = null, executionContext = '', machineHelp, localModel, requestInteraction, clientMessageId,
}) {
  const append = async (event) => {
    session.events.push(event);
    await save(session);
    onEvent?.(event);
    return event;
  };

  if (userText?.trim() || attachments?.length) {
    const event = userEvent(userText?.trim() ?? '', attachments ?? []);
    if (clientMessageId) event.clientMessageId = clientMessageId;
    await append(event);
  }

  // How a turn ended is structured on its note, so the UI never has to guess
  // a failure from wording. `reason` selects specific recovery help.
  const failed = (text, extra = {}) => append(noteEvent(text, { outcome: 'error', ...extra }));
  const stopped = () => append(noteEvent('Stopped by you.', { outcome: 'stopped' }));

  for (;;) {
    if (signal?.aborted) {
      await stopped();
      return {outcome:'cancelled'};
    }

    const configured = models[session.model];
    if (configured) validateEffort(configured, session.effort);
    const spec = configured && { ...configured, ...(session.claudePermission ? {permissionMode:session.claudePermission} : {}), ...(session.effort ? { effort: session.effort, reasoningEffort: session.effort } : {}) };
    if (!spec) {
      await failed(`The model this session uses (${session.model}) is not set up on this computer. Tap ⚙ beside the model to choose another.`, { reason: 'model' });
      return {outcome:'error'};
    }
    // People know models by name; the alias can be a generated id.
    const who = spec.label || spec.model || spec.alias;

    // Images are stored as files and only turned into base64 for the providers
    // that inline them — the CLI reads the file itself, which is far cheaper.
    let events = session.events;
    if (spec.provider !== 'claude-cli' && events.some((e) => e.attachments?.length)) {
      events = await Promise.all(events.map(async (e) => (
        e.attachments?.length
          ? {
            ...e,
            attachments: await Promise.all(e.attachments.map(async (a) => (
              a.role === 'document'
                ? { ...a, base64: await toBase64(a).catch(() => null) }
                : { ...a, dataUrl: await toDataUrl(a).catch(() => null) }
            ))),
          }
          : e
      )));
    }

    // Resume only an unchanged transcript on the same execution host/folder/model.
    // Editing history or changing providers deliberately starts a fresh native session.
    // Push and merge entries are DO's own: Claude never saw them, so they are not
    // edits. The resumed session is told about them instead.
    const conversation = e => ['user','assistant','tool_result'].includes(e.type);
    const hash = entries => crypto.createHash('sha256').update(JSON.stringify(entries.map(e => [e.id,e.text,e.toolCalls,e.output,e.attachments]))).digest('hex');
    const fingerprint = entries => hash(entries.filter(e => conversation(e) && e.operation !== 'push'));
    const before = session.events.filter(conversation).slice(0, -1);
    let since = before.length;
    while (since && before[since - 1].operation === 'push') since -= 1;
    const pushes = before.slice(since);
    const cwd = session.tabWorkspace?.cwd ?? session.tabWorkspace?.dir ?? session.projectDir;
    // Native identity is only reusable when execution semantics agree. Labels
    // and credentials are excluded; model definition and access policy are not.
    const context = crypto.createHash('sha256').update(JSON.stringify({
      model:spec.model, provider:spec.provider, bin:spec.bin, baseUrl:spec.baseUrl,
      system:session.system, executionContext, permission:spec.permissionMode || 'default',
      readableDirs:session.readableDirs || [], confined:session.confineToProjectDir,
      mode:session.mode, extraBody:spec.extraBody,
    })).digest('hex');
    const native = session.nativeClaude;
    // Sessions saved before pushes were left out still match their history without the latest ones.
    const unchanged = [fingerprint(before), hash(before.slice(0, since))].includes(native?.history);
    const resume = spec.provider === 'claude-cli' && native?.host === session.ownerNode && native?.cwd === cwd && native.model === session.model && native.context === context
      && unchanged ? native.id : null;
    const nativeNote = resume && pushes.length ? 'DO note, not from the user: since your last reply, these DO actions ran on this tab.\n'
      + pushes.map(e => `- ${e.type === 'user' ? 'Requested' : 'Result'}: ${String(e.text || '').slice(0, 400)}`).join('\n') : '';
    let nativeId;
    let reply;
    let streamed = 0;
    let stepSaves = Promise.resolve();
    const appendStep = async (st) => {
      streamed += 1;
      if (st.kind === 'tool_result') await append(toolResultEvent(st));
      else await append(assistantEvent({ ...st, model: spec.alias, provider: spec.provider }));
    };

    try {
      const provider = providerFor(spec);
      reply = await provider.complete({
        client: clientFor(spec),
        requestInteraction,
        nativeSession: resume,
        nativeNote,
        onContext: info => onDelta?.({kind:'native_context', ...info}),
        // Kept on the message it answers. The provider supplies every value it shows;
        // the requested ones are DO's setting, only ever used to flag a difference.
        onModelReport: (values) => {
          const sent = session.events.findLast(e => e.type === 'user');
          if (!sent) return;
          const requestedEffort = effortCapability(spec).configured;
          sent.modelReport = { ...values, at: Date.now(), ...(requestedEffort ? { requestedEffort } : {}), ...(spec.model ? { requestedModel: spec.model } : {}) };
          const report = { kind: 'model_report', eventId: sent.id, report: sent.modelReport };
          stepSaves = stepSaves.then(() => save(session)).then(() => onDelta?.(report));
          stepSaves.catch(() => {}); // awaited before the turn may finish
        },
        onNativeSession: id => { nativeId = id; },
        spec,
        events,
        system: systemPromptFor(session, tailnetHost, spec.provider === 'claude-cli') + (executionContext ? `\n\n${executionContext}` : ''),
        onText: (text) => onDelta?.({ kind: 'text', text }),
        onThinking: (text) => onDelta?.({ kind: 'thinking', text }),
        onToolStart: (call) => onDelta?.({ kind: 'tool_start', call }),
        onToolEnd: (result) => onDelta?.({ kind: 'tool_end', result }),
        // Providers stream without awaiting saves. Preserve order and drain all
        // writes before reporting completion; surface a persistence failure.
        onStep: (st) => {
          stepSaves = stepSaves.then(() => appendStep(st));
          stepSaves.catch(() => {}); // awaited before the turn may finish
        },
        onRateLimit: (info) => onDelta?.({ kind: 'rate_limit', info }),
        useTools: usesTools(session),
        longContext: Boolean(session.allowLongContext),
        signal,
        cwd: session.tabWorkspace?.cwd ?? session.tabWorkspace?.dir ?? session.projectDir,
      });
    } catch (e) {
      await stepSaves;
      if (signal?.aborted) { await stopped(); return {outcome:'cancelled'}; }
      await failed(`${who}: ${e?.message ?? String(e)}`, e?.reason ? { reason: e.reason } : {});
      return {outcome:'error'};
    }

    await stepSaves;
    // "Allow everything" chosen in a prompt keeps applying to later turns of this session.
    if (reply.permissionMode && reply.permissionMode !== session.claudePermission) {
      session.claudePermission = reply.permissionMode;
      await save(session);
    }
    if (nativeId && !reply.error) {
      session.nativeClaude = {id:nativeId, cwd, host:session.ownerNode, model:session.model, context, history:fingerprint(session.events)};
      await save(session);
    }

    // Some backends are whole agents (the `claude` CLI) and have already run
    // their own tools. They hand back an ordered list of what happened; the
    // harness records it and the turn is over.
    if (streamed || reply.steps?.length) {
      // Anything not already persisted as it streamed gets written now.
      if (!streamed) for (const st of reply.steps) await appendStep(st);

      // Per-message usage from a streaming agent is fragmentary - a few tokens
      // per chunk, and an input count that excludes everything served from
      // cache. The backend's end-of-turn totals are the real figure, so they
      // are attached to the turn's last message rather than discarded.
      if (reply.usage?.input || reply.usage?.output) {
        for (let i = session.events.length - 1; i >= 0; i -= 1) {
          if (session.events[i].type === 'assistant') {
            session.events[i].usage = { ...reply.usage, total: true };
            break;
          }
        }
        await save(session);
      }

      if (reply.error && signal?.aborted) { await stopped(); return {outcome:'cancelled'}; }
      if (reply.error) await failed(`${who}: ${reply.error}`, reply.errorReason ? { reason: reply.errorReason } : {});
      return {outcome:reply.error ? 'error' : 'responded'};
    }

    const event = await append(assistantEvent(reply));

    if (!usesTools(session) && event.toolCalls.length) {
      for (const call of event.toolCalls) await append(toolResultEvent({callId:call.id, name:call.name, ok:false, output:'Tool execution denied: this session has tools disabled.'}));
      await failed('The provider returned tool calls in no-tools mode. No tools were executed.');
      return {outcome:'error'};
    }
    if (reply.error && signal?.aborted) { await stopped(); return {outcome:'cancelled'}; }
    if (reply.error) {
      await failed(`${who}: ${reply.error}`, reply.errorReason ? { reason: reply.errorReason } : {});
      return {outcome:'error'};
    }
    if (['length','max_tokens'].includes(reply.stopReason)) {
      await failed('The provider reached its response token limit. This turn was cut short; the work may be unfinished.', { reason: 'length' });
      return {outcome:'error'};
    }
    if (!event.toolCalls.length) return; // the model is done talking

    for (const call of event.toolCalls) {
      if (signal?.aborted) {
        // Every tool call still needs a result or the transcript is invalid for
        // the next request, so record the cancellation as the result.
        await append(
          toolResultEvent({ callId: call.id, name: call.name, ok: false, output: 'stopped by user' }),
        );
        continue;
      }
      onDelta?.({ kind: 'tool_start', call });
      const result = await boundedTool(call, {
        projectDir: session.tabWorkspace?.cwd ?? session.tabWorkspace?.dir ?? session.projectDir,
        allowOutside: !session.confineToProjectDir,
        // The Harness app's sessions may edit the harness source (never its data).
        allowHarnessSource: Boolean(session.editsHarness),
        readableDirs: session.readableDirs ?? [],
        // So an email says which session sent it: several may be running
        // unattended, and "it finished" is useless without knowing which.
        sessionId: session.id,
        machineHelp, localModel,
      }, { signal, ms: spec.toolTimeoutMs ?? 120_000 });
      await append(
        toolResultEvent({ callId: call.id, name: call.name, ok: result.ok, output: result.output }),
      );
    }
  }


}
