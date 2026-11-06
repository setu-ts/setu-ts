// The support page's client: no build step, no dependencies. It reads a run's
// AI SDK UI message stream (server-sent events) from GET /runs/:id/stream and
// renders it as it arrives. Everything the model or a tool produced is inserted
// with textContent, never as HTML.
//
// The run id lives in the URL (#run=<id>), so a reload finds the run again:
// a live run is replayed from its stored log, a finished one is rebuilt from
// GET /runs/:id. When the connection drops (the server restarted, say), the
// page reconnects with the last event id it received, and the server resumes
// right after that chunk.

const log = document.getElementById('log');
const empty = document.getElementById('empty');
const form = document.getElementById('ask');
const message = document.getElementById('message');
const send = document.getElementById('send');
const cancel = document.getElementById('cancel');
const reset = document.getElementById('reset');
const statusBadge = document.getElementById('status');
const runLabel = document.getElementById('run-label');
const userInput = document.getElementById('user');
const ordersList = document.getElementById('orders');

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents) => money.format(cents / 100);

const TOOL_LABELS = { lookupOrder: 'Look up order', issueRefund: 'Issue refund' };

let runId = null;
let status = null;
let question = '';
// Earlier turns of this conversation, oldest first: each finished request's
// question and answer, sent with the next message so the model has context.
let earlier = [];
const MAX_TURNS = 20;
const MAX_TURN_CHARS = 4000;
// The message being rebuilt from the stream: an ordered list of parts.
let parts = [];
let lastEventId = null;
let streaming = null;
let notice = null;
// Whether the user acting now approves refunds (GET /me).
let approver = false;

function user() {
  return userInput.value.trim() || 'priya';
}

function headers(extra = {}) {
  return { 'x-demo-user': user(), ...extra };
}

/** Replaces the run's status badge and the controls that depend on it. */
function setStatus(next) {
  status = next;
  statusBadge.textContent = next ?? 'no run';
  statusBadge.className = `badge ${next ?? ''}`;
  const live = next === 'running' || next === 'ready' || next === 'waiting';
  cancel.disabled = !runId || !live;
  send.disabled = live;
  message.disabled = live;
  runLabel.textContent = runId ? `Run ${runId}` : 'Start a conversation below.';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function describeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'issueRefund')
    return `${dollars(input.amountCents)} on order ${input.orderId} — “${input.reason}”`;
  if (name === 'lookupOrder') return `Order ${input.orderId}`;
  return JSON.stringify(input);
}

function describeOutput(name, output) {
  if (!output || typeof output !== 'object') return '';
  if ('error' in output) return output.error;
  if (name === 'issueRefund')
    return `Refunded ${dollars(output.refundCents)}; ${dollars(output.remainingCents)} left to refund.`;
  if (name === 'lookupOrder')
    return `${output.customer}: ${output.item}, ${dollars(output.amountCents)}, ${dollars(output.refundedCents)} refunded so far.`;
  return JSON.stringify(output);
}

/** Draws the whole conversation from the current parts. */
function render() {
  log.replaceChildren();
  if (!runId) {
    log.append(empty);
    if (notice) log.append(element('div', `notice ${notice.bad ? 'bad' : ''}`, notice.text));
    return;
  }
  for (const turn of earlier)
    log.append(element('div', `msg ${turn.role === 'user' ? 'user' : 'agent'}`, turn.content));
  if (question) log.append(element('div', 'msg user', question));
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) log.append(element('div', 'msg agent', part.text));
      continue;
    }
    if (part.type !== 'tool') continue;
    const card = element('div', `tool ${part.state}`);
    const label = TOOL_LABELS[part.toolName] ?? part.toolName;
    card.append(element('div', 'name', label));
    card.append(element('div', 'detail', describeInput(part.toolName, part.input)));
    if (part.state === 'pending') {
      if (approver) {
        card.append(element('div', 'detail', 'Waiting for your approval.'));
        card.append(decisionControls(part));
      } else
        card.append(
          element(
            'div',
            'detail',
            'Waiting for a support lead to approve. In this demo, switch “Acting as” to lead to decide.',
          ),
        );
    } else if (part.state === 'running') {
      card.append(element('div', 'detail', 'Running…'));
    } else if (part.state === 'done') {
      card.append(element('div', 'detail', describeOutput(part.toolName, part.output)));
    } else if (part.state === 'denied') {
      card.append(
        element('div', 'detail', `Not approved${part.reason ? `: ${part.reason}` : '.'}`),
      );
    } else if (part.state === 'error') {
      card.append(element('div', 'detail', 'The tool failed.'));
    }
    log.append(card);
  }
  if (notice) log.append(element('div', `notice ${notice.bad ? 'bad' : ''}`, notice.text));
  else if (status === 'running' || status === 'ready') {
    // The model can think for a while before its first token: say so.
    const last = parts.at(-1);
    if (!last || last.type !== 'text' || !last.text)
      log.append(element('div', 'notice working', 'The agent is working…'));
  }
  log.scrollTop = log.scrollHeight;
}

function decisionControls(part) {
  const row = element('div', 'decision');
  const reason = element('input');
  reason.placeholder = 'Reason (optional)';
  reason.maxLength = 200;
  const approve = element('button', 'approve', 'Approve');
  const deny = element('button', 'deny', 'Deny');
  const decide = async (approved) => {
    approve.disabled = deny.disabled = true;
    const body = { approved };
    if (reason.value.trim()) body.reason = reason.value.trim();
    let res;
    try {
      res = await fetch(
        `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(part.approvalId)}`,
        {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(body),
        },
      );
    } catch {
      // The server went away before answering. The decision may have been
      // recorded, so follow the run: the stream shows what actually happened.
      notice = { text: 'Connection lost. Reconnecting…' };
      render();
      void follow();
      return;
    }
    if (!res.ok) {
      approve.disabled = deny.disabled = false;
      notice = { text: `The decision was not accepted (${res.status}).`, bad: true };
      render();
      return;
    }
    part.state = 'running';
    setStatus('running');
    render();
    void follow();
  };
  approve.addEventListener('click', () => void decide(true));
  deny.addEventListener('click', () => void decide(false));
  row.append(reason, approve, deny);
  return row;
}

/** This conversation as text turns, for the next request: earlier turns, then this run's. */
function conversation() {
  const answer = parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n\n');
  const turns = [...earlier];
  if (question) turns.push({ role: 'user', content: question });
  if (answer) turns.push({ role: 'assistant', content: answer });
  return turns
    .slice(-MAX_TURNS)
    .map((t) => ({ ...t, content: t.content.slice(0, MAX_TURN_CHARS) }));
}

/** The text of a stored message's content, or '' when it holds none. */
function textOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function tool(toolCallId) {
  return parts.find((p) => p.type === 'tool' && p.toolCallId === toolCallId);
}

/** Applies one UI message chunk to the parts, the way the AI SDK client does. */
function apply(chunk) {
  switch (chunk.type) {
    case 'data-setu-replay':
      // The stored log disagrees with what this page received (another server
      // took the run over): discard it and rebuild from the replay that follows.
      parts = [];
      break;
    case 'start-step':
      parts.push({ type: 'step' });
      break;
    case 'reset-step': {
      // A model call was interrupted and is being retried: drop its partial output.
      const start = parts.map((p) => p.type).lastIndexOf('step');
      parts = start === -1 ? [] : parts.slice(0, start + 1);
      break;
    }
    case 'text-start':
      parts.push({ type: 'text', id: chunk.id, text: '' });
      break;
    case 'text-delta': {
      const text = [...parts].reverse().find((p) => p.type === 'text' && p.id === chunk.id);
      if (text) text.text += chunk.delta;
      break;
    }
    case 'tool-input-available':
      if (!tool(chunk.toolCallId))
        parts.push({
          type: 'tool',
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          input: chunk.input,
          state: 'running',
        });
      break;
    case 'tool-approval-request': {
      const part = tool(chunk.toolCallId);
      if (part) Object.assign(part, { state: 'pending', approvalId: chunk.approvalId });
      setStatus('waiting');
      break;
    }
    case 'tool-approval-response': {
      const part = parts.find((p) => p.type === 'tool' && p.approvalId === chunk.approvalId);
      if (part && part.state === 'pending') {
        part.state = chunk.approved ? 'running' : 'denied';
        if (chunk.reason) part.reason = chunk.reason;
      }
      // Decided: the run goes on (a replay passes through here too).
      if (status === 'waiting') setStatus('running');
      break;
    }
    case 'tool-output-available': {
      const part = tool(chunk.toolCallId);
      if (part) Object.assign(part, { state: 'done', output: chunk.output });
      break;
    }
    case 'tool-output-denied': {
      const part = tool(chunk.toolCallId);
      if (part) part.state = 'denied';
      break;
    }
    case 'tool-output-error': {
      const part = tool(chunk.toolCallId);
      if (part) part.state = 'error';
      break;
    }
    case 'finish':
      setStatus('completed');
      break;
    case 'abort':
      setStatus('cancelled');
      break;
    case 'error':
      setStatus('failed');
      notice = { text: chunk.errorText || 'The run failed.', bad: true };
      break;
    default:
      break;
  }
}

/** Reads the run's stream until it ends, resuming after `lastEventId`. */
async function follow() {
  if (!runId) return;
  streaming?.abort();
  const controller = new AbortController();
  streaming = controller;
  const id = runId;
  try {
    const res = await fetch(`/runs/${encodeURIComponent(id)}/stream`, {
      headers: headers(lastEventId ? { 'last-event-id': lastEventId } : {}),
      signal: controller.signal,
    });
    if (res.status === 204) {
      await load();
      return;
    }
    if (res.status >= 400 && res.status < 500) {
      // Not this user's run, or gone: retrying cannot help.
      await load();
      return;
    }
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    notice = null;
    retryDelay = MIN_RETRY_MS;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) lastEventId = line.slice(4);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data || data === '[DONE]') continue;
        apply(JSON.parse(data));
      }
      render();
    }
    // The stream ended: either the run finished, or it parked for an approval.
    await refreshStatus(id, controller.signal);
    void loadOrders();
  } catch {
    if (controller.signal.aborted || id !== runId) return;
    // The server went away mid-run. Retry, waiting longer each time; the run
    // itself is not lost.
    notice = { text: 'Connection lost. Reconnecting…' };
    render();
    later(id, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  }
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;
const WAITING_RETRY_MS = 3000;
let retryDelay = MIN_RETRY_MS;

/** Follows the run again after a pause, unless the page has moved on. */
function later(id, ms) {
  setTimeout(() => {
    if (id === runId) void follow();
  }, ms);
}

/** Applies a run's current status, unless the page has moved to another run meanwhile. */
async function refreshStatus(id, signal) {
  if (signal.aborted || id !== runId) return;
  const res = await fetch(`/runs/${encodeURIComponent(id)}`, { headers: headers() });
  if (signal.aborted || id !== runId) return;
  if (res.status >= 500) {
    // A server fault: try again through the usual backoff.
    notice = { text: 'The server had a problem. Reconnecting…' };
    render();
    later(id, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    return;
  }
  if (!res.ok) {
    // Not this user's run any more, or gone: retrying cannot help.
    notice = { text: `The run could not be loaded (${res.status}).`, bad: true };
    setStatus(null);
    render();
    return;
  }
  const view = await res.json();
  if (signal.aborted || id !== runId) return;
  setStatus(view.status);
  // The stream ended while the run is still going (another server holds it,
  // or it is about to be resumed): look again shortly, not straight away.
  if (view.status === 'running' || view.status === 'ready') later(runId, MIN_RETRY_MS);
  // Parked for an approval that someone else (a lead, in another browser)
  // may give at any time: keep checking, more gently.
  else if (view.status === 'waiting') later(runId, WAITING_RETRY_MS);
  render();
}

/** Rebuilds a finished run from GET /runs/:id: its stored model messages. */
async function load() {
  const id = runId;
  const res = await fetch(`/runs/${encodeURIComponent(id)}`, { headers: headers() });
  // The page moved to another run (or a new conversation) while this answered.
  if (id !== runId) return;
  if (res.status === 404) {
    notice = { text: 'This run does not exist, or belongs to another user.', bad: true };
    parts = [];
    question = '';
    earlier = [];
    setStatus(null);
    render();
    return;
  }
  if (!res.ok) {
    // A server fault, not an answer: say so instead of reading the error as a run.
    notice = {
      text: `The run could not be loaded (${res.status}). Reload to try again.`,
      bad: true,
    };
    setStatus(null);
    render();
    return;
  }
  const view = await res.json();
  if (id !== runId) return;
  parts = [];
  question = '';
  notice = null;
  // The run's input is the conversation so far plus this request: the last
  // user message is the question, anything before it is earlier turns.
  const asked = view.messages.map((m) => m.role).lastIndexOf('user');
  earlier = view.messages
    .slice(0, Math.max(asked, 0))
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: textOf(m.content) }))
    .filter((t) => t.content);
  if (asked !== -1) question = textOf(view.messages[asked].content);
  for (const msg of view.messages.slice(asked + 1)) {
    const content =
      typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
    for (const c of content ?? []) {
      if (c.type === 'text') parts.push({ type: 'text', id: String(parts.length), text: c.text });
      if (c.type === 'tool-call')
        parts.push({
          type: 'tool',
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
          state: 'running',
        });
      if (c.type === 'tool-result') {
        const part = tool(c.toolCallId);
        if (!part) continue;
        if (c.output?.type === 'execution-denied')
          Object.assign(part, { state: 'denied', reason: c.output.reason });
        else if (c.output?.type === 'error-text') part.state = 'error';
        else Object.assign(part, { state: 'done', output: c.output?.value });
      }
    }
  }
  for (const approval of view.pendingApprovals) {
    const part = tool(approval.toolCallId);
    if (part) Object.assign(part, { state: 'pending', approvalId: approval.id });
  }
  setStatus(view.status);
  if (view.status === 'failed') notice = { text: 'The run failed.', bad: true };
  render();
}

async function loadMe() {
  const res = await fetch('/me', { headers: headers() });
  approver = res.ok ? (await res.json()).approver : false;
}

async function loadOrders() {
  const res = await fetch('/orders', { headers: headers() });
  if (!res.ok) return;
  const { orders } = await res.json();
  ordersList.replaceChildren(
    ...orders.map((order) => {
      const row = element('div', 'order');
      row.append(element('div', 'id', `${order.id} · ${dollars(order.amountCents)}`));
      row.append(element('div', 'meta', `${order.customer} — ${order.item}`));
      if (order.refundedCents > 0)
        row.append(element('div', 'refunded', `Refunded ${dollars(order.refundedCents)}`));
      return row;
    }),
  );
}

function openRun(id, turns = []) {
  streaming?.abort();
  runId = id;
  parts = [];
  question = '';
  earlier = turns;
  lastEventId = null;
  notice = null;
  if (id) history.replaceState(null, '', `#run=${encodeURIComponent(id)}`);
  else history.replaceState(null, '', location.pathname);
  setStatus(id ? 'running' : null);
  render();
}

async function start(text) {
  // A finished run continues as a conversation: the next request carries it.
  const turns = runId && status !== null ? conversation() : [];
  // On any failure the message goes back into the box, so it can be resent.
  const refused = (why) => {
    message.value = text;
    notice = { text: why, bad: true };
    render();
  };
  let res;
  try {
    res = await fetch('/runs', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ message: text, history: turns }),
    });
  } catch {
    refused('The server could not be reached. Your message is still in the box; send it again.');
    return;
  }
  if (!res.ok) {
    refused(`The request was refused (${res.status}).`);
    return;
  }
  const { runId: id } = await res.json();
  openRun(id, turns);
  question = text;
  render();
  void follow();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = message.value.trim();
  if (!text) return;
  message.value = '';
  void start(text);
});

message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

cancel.addEventListener('click', async () => {
  cancel.disabled = true;
  let failure = null;
  try {
    const res = await fetch(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: headers(),
    });
    if (!res.ok) failure = `The run could not be cancelled (${res.status}).`;
  } catch {
    failure = 'The server could not be reached to cancel the run.';
  }
  if (failure) {
    // The run goes on: give Cancel back, show why, and leave any open stream
    // alone (reconnecting would clear the notice).
    notice = { text: failure, bad: true };
    setStatus(status);
    render();
    return;
  }
  void follow();
});

reset.addEventListener('click', () => {
  openRun(null);
  message.focus();
});

/** Finds a run again after a reload or a change of user. */
async function resume() {
  await load();
  if (status === 'running' || status === 'ready' || status === 'waiting') {
    // A live run: replay its whole stored log, then follow it.
    parts = [];
    lastEventId = null;
    void follow();
  }
}

globalThis.addEventListener('hashchange', () => {
  const id = new URLSearchParams(location.hash.slice(1)).get('run');
  if (id && id !== runId) {
    openRun(id);
    void resume();
  }
});

userInput.addEventListener('change', async () => {
  // Runs belong to the customer who started them (and the leads who review
  // them); anyone else sees a 404. Orders are each customer's own.
  await loadMe();
  void loadOrders();
  if (runId) void resume();
  else render();
});

const fromHash = new URLSearchParams(location.hash.slice(1)).get('run');
await loadMe();
void loadOrders();
if (fromHash) {
  openRun(fromHash);
  void resume();
} else {
  setStatus(null);
  render();
}
