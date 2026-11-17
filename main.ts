// main.ts — front door of the git forge.
//
// This file only plugs the server from app.ts into the trial environment:
// it asks the kernel for a free port, tells the environment that port, and
// then waits until the environment says the trial is done before leaving.
// The forge itself — git, REST, GraphQL and MCP — lives in app.ts and
// src/; this file knows none of those details.

import { createApp } from './app.ts';

// The trial environment's base address, with any trailing slash removed.
const envRoot = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

// Pause between two attempts, or two questions, in milliseconds.
const restMs = 500;

// How many times announcing the port is retried before giving up.
const announceTries = 60;

// How long one question to the environment may hang before asking again.
const askTimeoutMs = 10_000;

// How long open sockets get to drain once the trial is over.
const drainMs = 2000;

type ForgeServer = ReturnType<typeof createApp>;

let leaving = false;

function nap(ms: number): Promise<void> {
  return new Promise<void>((wake) => {
    setTimeout(wake, Math.max(0, ms));
  });
}

function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

// Tell the environment which port the forge listens on. Retries for a
// while when the environment is slow to answer or refuses.
async function announce(port: number): Promise<boolean> {
  for (let attempt = 1; attempt <= announceTries; attempt += 1) {
    try {
      const reply = await fetch(`${envRoot}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(askTimeoutMs),
      });
      if (reply.ok) return true;
      note(`announce: environment answered HTTP ${reply.status} (attempt ${attempt})`);
    } catch (e) {
      note(`announce: ${e instanceof Error ? e.message : String(e)} (attempt ${attempt})`);
    }
    if (attempt < announceTries) await nap(restMs);
  }
  return false;
}

// Ask the environment once whether the trial is over.
async function trialOver(): Promise<boolean> {
  try {
    const reply = await fetch(`${envRoot}/done`, {
      signal: AbortSignal.timeout(askTimeoutMs),
    });
    if (!reply.ok) return false;
    const payload: unknown = await reply.json();
    if (typeof payload !== 'object' || payload === null) return false;
    return (payload as { done?: unknown }).done === true;
  } catch {
    return false;
  }
}

// Keep asking until the environment says the trial is over.
async function waitForFinish(): Promise<void> {
  for (;;) {
    if (leaving) return;
    if (await trialOver()) return;
    await nap(restMs);
  }
}

// Shut the server down and leave with the given status. Safe to call
// more than once; only the first call acts.
function depart(server: ForgeServer, status: number): void {
  if (leaving) return;
  leaving = true;
  try {
    server.closeIdleConnections();
  } catch {
    // Not every runtime offers this; closing below still proceeds.
  }
  server.close(() => {
    process.exit(status);
  });
  setTimeout(() => {
    process.exit(status);
  }, drainMs).unref();
}

async function boot(): Promise<void> {
  if (envRoot === '') {
    note('no MAKEFUN_ENV_URL: cannot announce a port, leaving');
    process.exit(1);
  }
  const server = createApp();
  process.once('SIGTERM', () => depart(server, 0));
  process.once('SIGINT', () => depart(server, 0));
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (e: Error): void => {
      reject(e);
    };
    server.once('error', onError);
    server.listen(0, '0.0.0.0', () => {
      const where = server.address();
      server.removeListener('error', onError);
      server.on('error', (e) => {
        note(`server error: ${e.message}`);
      });
      if (typeof where === 'object' && where !== null) {
        resolve(where.port);
      } else {
        reject(new Error('server bound without a port'));
      }
    });
  });
  note(`forge listening on port ${port}`);
  if (!(await announce(port))) {
    note('could not announce the port; leaving');
    server.close();
    process.exit(1);
  }
  note('port announced; waiting for the trial to finish');
  await waitForFinish();
  depart(server, 0);
}

void boot().catch((e) => {
  note(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
