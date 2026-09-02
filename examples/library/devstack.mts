#!/usr/bin/env node

/* devstack.mts: run your dev stack with build steps, startup checks, and a TUI.

   Call `main()` with your config right in this file (see below), or import
   it from another file and call `main()` there.

   "Install" this tool by copy/pasting it into your project.

   Original file licensed under Apache License 2.0.  See:

     https://github.com/phaselock-io/phaselock/blob/master/LICENSE

   Copyright (c) 2026 Kurrent, Inc.  All rights reserved.
   Copyright (c) 2026 PhaseLock, LLC.  All rights reserved.
*/

main({
  commands: {
    G: ["make", "gen"],
  },
  stages: {
    // run KurrentDB in a docker container
    db: {
      containerName: "todo-basic-db",
      dockerArgs: ["-p=2113:2113"],
      image: "docker.kurrent.io/kurrent-latest/kurrentdb:26.0.3",
      cmd: [
        "--insecure",
        "--run-projections=System",
        "--enable-atom-pub-over-http",
      ],
      post: [
        httpCheck("http://localhost:2113/health/live?liveCode=200"),
        exec("python3", "populate.py"),
        // a new db container means the old on-disk stores are stale
        exec("rm", "-rf", "decider/.bbolt"),
        exec("rm", "-rf", "relay/.lmdb"),
      ],
    },
    // then run the go decider
    decider: {
      cwd: "decider",
      pre: exec("make", "-C", "..", "decider"),
      cmd: ["./decider"],
    },
    // then run the python relay
    relay: {
      pre: exec("make", "relay"),
      cmd: ["python", "-u", "relay/relay.py"],
      post: connCheck(3001),
    },
    // then run the ui
    ui: {
      cwd: "ui",
      cmd: ["./node_modules/.bin/vite", "dev"],
    },
  },
});

////////////////// devstack internals below this line //////////////////////////

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { connect } from 'node:net';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite'; // literally just for file locks
import { setTimeout as sleep } from 'node:timers/promises';

function usage(out: NodeJS.WriteStream): void {
  out.write(
    'usage: node devstack.mts [options]\n' +
      '  -1, --oneshot           no UI; stream logs to stdout and announce\n' +
      '                          readiness on stderr (for CI; implied when\n' +
      '                          stdin or stdout is not a terminal)\n' +
      "  --target-stage <stage>  initial target, by name, index, or 'dead'\n" +
      '                          (default: the last stage)\n' +
      '  -h, --help              show this help\n' +
      '\n' +
      'KEYBINDINGS:\n' +
      '  0-9         set target stage\n' +
      '  shift+(0-9) enable/disable logs for each stage\n' +
      '  k/up        scroll up one line\n' +
      '  u           scroll up one half page\n' +
      '  b/pgup      scroll up one full page\n' +
      '  j/down      scroll down one line\n' +
      '  d           scroll down one half page\n' +
      '  f/pgdn      scroll down one full page\n' +
      '  x           when scrolled, jump back to bottom\n',
  );
}

/////////////////////////////////////////////////////////
// config types (which are also code-as-documentation) //
/////////////////////////////////////////////////////////

export type Config = {
  // stages, by name; they boot in source order (so avoid numeric names)
  stages: Record<string, ProcessStage | DockerStage>;
  // one-off commands bound to hotkeys, e.g. { B: "pnpm build" }
  // if a plain string, runs via `sh -c`
  commands?: Record<string, string | string[]>;
  // keys processed by the UI at startup, as if the user had typed them
  startupInput?: string;
  // where devstack should store its state, including lockfile
  tempDir?: string;
};

export type ProcessStage = {
  // What to run.  if a plain string, runs via `sh -c`.
  cmd: string | string[];
  // where to run it.
  cwd?: string;
  // env keys to merge into devstack's own environment
  env?: Record<string, string>;
  // step(s) to complete before starting cmd
  pre?: Step | Step[];
  // step(s) to complete after starting cmd, before the stage counts as up
  post?: Step | Step[];
  // how devstack should kill the process
  killSignal?: KillSignal;
};

export type DockerStage = {
  containerName: string;
  // docker args to `docker container create --name <containerName>`
  dockerArgs?: string[];
  // the image to run
  image: string;
  // what command (and args) to run inside the image
  cmd?: string[];
  // pre and post steps run on the host, not in the container
  pre?: Step | Step[];
  post?: Step | Step[];
  // sent to stop the container via `docker kill --signal` (default SIGTERM)
  killSignal?: KillSignal;
};

// A Step is started once, and done when its promise settles.  Rejecting the
// promise crashes the stage.  Examples: sh(), exec(), connCheck(),
// httpCheck(), logCheck()
export type Step = (ctx: StepCtx) => Promise<void>;

export type StepCtx = {
  // aborts when the step is preempted (stage killed, target lowered, quit)
  signal: AbortSignal;
  // write a line to this stage's log stream
  log: (line: string) => void;
  // the name of this stage's log stream
  stream: string;
  // the stage's cwd, when it has one; subprocess steps run from there
  cwd?: string;
};

// autocompletes the common signals but accepts any signal name
export type KillSignal = 'SIGTERM' | 'SIGINT' | 'SIGKILL' | (string & {});

///////////////////////////////////////////////////////////////////
// begin advancer: one function (`advance()`) to drive all state //
///////////////////////////////////////////////////////////////////

let scheduled = false;
let finished = false;

// request advance() to run again soon, idempotently
export function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    if (finished) return;
    advance();
  });
}

// the active stack definition, assigned by main()
let config: Config;

// runtime options, set at startup from argv and tty detection
export const opts = {
  /* Oneshot mode has no TUI, and crashes everything if any stage crashes.
     prints "devstack is up" to stderr when target stage is reached. */
  oneshot: false,
};

// current state of the stack, owned by advance()
export const status = {
  // one entry per configured stage, in boot order (stage indices elsewhere
  // are 1-based; index 0 is the implicit DEAD state)
  stages: [] as StageState[],
};

// target state of the stack, mutated by input handlers, consumed by advancer
export const target = {
  // the stage index the user wants the cluster walked to (0 = DEAD)
  targetIdx: 0,
  // hotkeys pressed for one-off commands (see Config.commands)
  commandKeyPresses: [] as string[],
  quitRequested: false,
};

// The root advancer: drive stages, commands, quits, and renders.
function advance(): void {
  advanceStages();
  advanceCommands();

  if (opts.oneshot) {
    // oneshot print and quit hooks
    advanceOneshot();
  }

  /* Quit is complete: release our handles and let the event loop drain,
     which flushes stdout on the way out (a hard process.exit would truncate
     pending pipe writes).  Late wakeups land here again harmlessly; every
     action below is idempotent. */
  if (target.quitRequested && status.stages.every(isFullyDown) && commands.size === 0) {
    if (opts.oneshot) renderOneshot(true);
    restoreTerminal();
    process.exitCode = oneshot.failing ? 1 : 0;
    // never enter advance() again
    finished = true;
    return;
  }

  // otherwise repaint
  advanceRender();
}

/* Last-ditch handler for a bug or unexpected system failure inside advance().
   Not a ladder: our own state is suspect, so this is synchronous best-effort
   cleanup with no parking and no retries. */
function panic(err: unknown): never {
  restoreTerminal();
  killEverything();
  console.error(err);
  process.exit(1);
}

/* Best-effort, synchronous kill pass for panic and force-quit: every live
   child gets its stage's configured kill signal (never a blanket SIGKILL,
   which can corrupt complex children like databases). */
function killEverything(): void {
  for (const st of status.stages) {
    const signal = normSignal(st.cfg.killSignal ?? 'SIGTERM');
    if (isDocker(st.cfg)) {
      if (!st.containerStarted) continue;
      try {
        spawn('docker', ['kill', `--signal=${signal}`, st.cfg.containerName], {
          stdio: 'ignore',
          detached: true,
        }).unref();
      } catch {}
    } else {
      const proc = st.proc;
      if (proc === null || proc.exited || proc.pid === null) continue;
      try {
        process.kill(-proc.pid, signal);
      } catch {}
    }
  }
  for (const cmd of commands.values()) {
    if (cmd.exited || cmd.pid === null) continue;
    try {
      process.kill(-cmd.pid, 'SIGTERM');
    } catch {}
  }
}

//////////////////////////////////////////////////////////////////////////////
// stage management: driving startup and teardown of long-running processes //
//////////////////////////////////////////////////////////////////////////////

export type StageState = {
  name: string;
  cfg: ProcessStage | DockerStage;

  // the stand-up ladder, reset by resetRun()
  preSteps: Step[];
  postSteps: Step[];
  preDone: number;
  postDone: number;
  postStarted: boolean;
  up: boolean;
  crashed: boolean;

  // for docker stages
  containerId: string;
  containerStarted: boolean;

  // teardown, driven by the run ladder when wantDown is set
  wantDown: boolean;
  killSent: boolean;
  // the docker rm leaf: launched at most once, parked on until it settles
  rmStarted: boolean;
  rmPending: boolean;

  // the long-running process; non-null from spawn until fully torn down
  proc: Proc | null;
};

/* The long-running process behind a stage.  For docker stages this is the
   `docker logs --follow` process; the container itself is tracked by
   StageState.containerId/containerStarted. */
export type Proc = {
  child: ChildProcess;
  pid: number | null;
  // a kill was requested, so an exit is expected and is not a crash
  dying: boolean;
  // the child is gone and its output streams are closed
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
};

/* Only one pre/post step runs at a time across the whole cluster.  This is
   the slot; advanceStages() fills it and consumes its result. */
const stepSlot = {
  current: null as null | {
    // which stage the step belongs to (1-based, like targetIdx)
    stageIdx: number;
    kind: 'pre' | 'dockerCreate' | 'dockerStart' | 'post';
    controller: AbortController;
    settled: boolean;
    ok: boolean;
    error: unknown;
  },
};

// the stage whose step occupies the slot, if any
function stepSlotOwner(): StageState | null {
  return stepSlot.current === null ? null : status.stages[stepSlot.current.stageIdx - 1];
}

// a stage with a step in flight is not down, even before its proc spawns;
// that is what routes mid-pre-step stages into the teardown walk
function isFullyDown(st: StageState): boolean {
  return st.proc === null && st.containerId === '' && stepSlotOwner() !== st;
}

// return a stage's run state to pristine DOWN
function resetRun(st: StageState): void {
  st.preDone = 0;
  st.postDone = 0;
  st.postStarted = false;
  st.up = false;
  st.crashed = false;
  st.containerId = '';
  st.containerStarted = false;
  st.wantDown = false;
  st.killSent = false;
  st.rmStarted = false;
  st.rmPending = false;
  st.proc = null;
}

// quit walks to DEAD no matter what the keys last said
function effectiveTarget(): number {
  return target.quitRequested ? 0 : target.targetIdx;
}

function advanceStages(): void {
  consumeStep();
  // a step belonging to a crashed stage has nothing left to contribute
  const slot = stepSlot.current;
  if (slot !== null && status.stages[slot.stageIdx - 1].crashed) {
    if (!slot.controller.signal.aborted) slot.controller.abort();
  }

  /* Tear down from the top: everything above the target comes down, one at
     a time.  wantDown latches, so a teardown runs to completion even if the
     target moves back up -- and it overrides the fully-down skip, so a
     crashed stage with nothing left running still resets (clearing crashed)
     when its key requests a restart. */
  for (let i = status.stages.length; i > effectiveTarget(); i--) {
    const st = status.stages[i - 1];
    if (isFullyDown(st) && !st.wantDown) continue;
    st.wantDown = true;
    if (!advanceTearDown(st, i)) return;
  }

  // Stand up from the bottom.  A condemned stage (a restart, or a teardown
  // the target moved back above) finishes coming down first, and a crashed
  // stage parks the walk until the user acts on it.
  for (let i = 1; i <= effectiveTarget(); i++) {
    const st = status.stages[i - 1];
    if (st.wantDown && !advanceTearDown(st, i)) return;
    if (st.crashed) return;
    if (st.up) continue;
    if (!advanceStandUp(i)) return;
  }
}

// collect a settled step's result and free the slot
function consumeStep(): void {
  const slot = stepSlot.current;
  if (!slot?.settled) return;
  stepSlot.current = null;
  const st = status.stages[slot.stageIdx - 1];
  if (slot.controller.signal.aborted) {
    log(fore(3) + `${st.name} ${slot.kind} step canceled` + RES + '\n');
    return;
  }
  if (!slot.ok) {
    st.crashed = true;
    const msg = `${st.name} ${slot.kind} step failed: ${errText(slot.error)}`;
    log(fore(1) + msg + RES + '\n');
    log(fore(1) + msg + RES + '\n', st.name);
    return;
  }
  if (slot.kind === 'pre') st.preDone++;
  if (slot.kind === 'post') st.postDone++;
}

// returns true once the stage is up; false means parked on a step
function advanceStandUp(idx: number): boolean {
  // one step at a time; consumeStep() frees the slot once a step settles
  if (stepSlot.current !== null) return false;
  const st = status.stages[idx - 1];

  if (st.preDone < st.preSteps.length) {
    startStep(st, idx, 'pre', st.preSteps[st.preDone]);
    return false;
  }

  // docker stages: between pre and post steps, the container is created
  // (which registers it in running.json) and then started
  if (isDocker(st.cfg) && st.containerId === '') {
    startStep(st, idx, 'dockerCreate', dockerCreateStep(st));
    return false;
  }
  if (isDocker(st.cfg) && !st.containerStarted) {
    startStep(st, idx, 'dockerStart', dockerStartStep(st));
    return false;
  }

  if (!st.postStarted) {
    st.postStarted = true;
    if (st.postDone < st.postSteps.length) {
      startStep(st, idx, 'post', st.postSteps[st.postDone]);
      spawnMain(st);
      return false;
    }
    spawnMain(st);
    st.up = true;
    return true;
  }

  if (st.postDone < st.postSteps.length) {
    startStep(st, idx, 'post', st.postSteps[st.postDone]);
    return false;
  }

  st.up = true;
  return true;
}

// returns true once the stage is fully down; false means parked
function advanceTearDown(st: StageState, idx: number): boolean {
  // a step belonging to this stage dies with it; park until it settles
  const slot = stepSlot.current;
  if (slot !== null && slot.stageIdx === idx) {
    if (!slot.controller.signal.aborted) slot.controller.abort();
    return false;
  }

  if (st.proc !== null && !st.proc.exited) {
    if (!st.killSent) {
      st.killSent = true;
      st.proc.dying = true;
      sendKill(st);
    }
    return false; // park until the exit event arrives
  }

  // a started container whose log follower never spawned has no exit event
  // to park on; kill it here and let the rm leaf below wait for it
  if (st.proc === null && st.containerStarted && !st.killSent) {
    st.killSent = true;
    sendKill(st);
  }

  // remove the stage's container and drop it from running.json
  if (st.containerId !== '') {
    if (!st.rmStarted) {
      st.rmStarted = true;
      st.rmPending = true;
      dockerRm(st).then(() => {
        st.rmPending = false;
        schedule();
      });
    }
    if (st.rmPending) return false;
  }

  resetRun(st);
  return true;
}

// launch one pre/post step into the slot
function startStep(
  st: StageState,
  stageIdx: number,
  kind: 'pre' | 'dockerCreate' | 'dockerStart' | 'post',
  step: Step,
): void {
  const controller = new AbortController();
  const slot = {
    stageIdx,
    kind,
    controller,
    settled: false,
    ok: false,
    error: undefined as unknown,
  };
  stepSlot.current = slot;
  const ctx: StepCtx = {
    signal: controller.signal,
    log: (line) => log(line.endsWith('\n') ? line : line + '\n', st.name),
    stream: st.name,
    cwd: 'cwd' in st.cfg ? st.cfg.cwd : undefined,
  };
  Promise.resolve()
    .then(() => step(ctx))
    .then(
      () => {
        slot.ok = true;
      },
      (error: unknown) => {
        slot.error = error;
      },
    )
    .then(() => {
      slot.settled = true;
      schedule();
    });
}

export function isDocker(cfg: ProcessStage | DockerStage): cfg is DockerStage {
  return 'containerName' in cfg;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function newProc(child: ChildProcess): Proc {
  return {
    child,
    pid: child.pid ?? null,
    dying: false,
    exited: false,
    exitCode: null,
    exitSignal: null,
  };
}

// spawn the stage's long-running process (for docker: the log follower)
function spawnMain(st: StageState): void {
  let child: ChildProcess;
  if (isDocker(st.cfg)) {
    child = spawn('docker', ['container', 'logs', '--follow', st.cfg.containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } else {
    const cfg = st.cfg;
    log(fore(3) + `starting ${st.name}` + RES + '\n');
    const options = {
      cwd: cfg.cwd,
      env: cfg.env ? { ...process.env, ...cfg.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[],
      // a separate process group isolates the child from terminal signals
      // and lets kills reach the whole group
      detached: true,
    };
    child =
      typeof cfg.cmd === 'string'
        ? spawn(cfg.cmd, { ...options, shell: true })
        : spawn(cfg.cmd[0], cfg.cmd.slice(1), options);
  }
  const proc = newProc(child);
  st.proc = proc;
  wireChild(st, proc, child);
  if (isDocker(st.cfg)) {
    trackPid(proc.pid, `docker container logs --follow ${st.cfg.containerName}`, 'SIGKILL');
  } else {
    const cmd = st.cfg.cmd;
    trackPid(
      proc.pid,
      typeof cmd === 'string' ? cmd : cmd.join(' '),
      normSignal(st.cfg.killSignal ?? 'SIGTERM'),
    );
  }
}

function wireChild(st: StageState, proc: Proc, child: ChildProcess): void {
  child.stdout?.on('data', (b: Buffer) => log(b, st.name));
  child.stderr?.on('data', (b: Buffer) => log(b, st.name));

  const markExited = (what: string) => {
    if (proc.exited) return;
    proc.exited = true;
    untrackPid(proc.pid);
    log(`${st.name} exited with ${what}\n`);
    log(` ----- ${st.name} exited with ${what} -----\n`, st.name);
    if (!proc.dying) {
      st.crashed = true;
      log(fore(1) + `${st.name} closing unexpectedly!` + RES + '\n');
    }
    schedule();
  };

  child.on('error', (err: Error) => {
    // spawn failures land here (e.g. the command does not exist)
    log(fore(1) + `${st.name}: ${err.message}` + RES + '\n', st.name);
    markExited(`spawn error: ${err.message}`);
  });
  child.on('close', (code, signal) => {
    proc.exitCode = code;
    proc.exitSignal = signal;
    markExited(signal !== null ? `signal ${signal}` : `code ${code}`);
  });
}

// accept bare signal names like "TERM" for "SIGTERM", as `kill` does
function normSignal(sig: string): NodeJS.Signals {
  return (sig.startsWith('SIG') ? sig : 'SIG' + sig) as NodeJS.Signals;
}

function sendKill(st: StageState): void {
  const signal = normSignal(st.cfg.killSignal ?? 'SIGTERM');
  if (isDocker(st.cfg)) {
    log(fore(3) + `killing ${st.name} (docker kill --signal=${signal})` + RES + '\n');
    const p = spawn('docker', ['kill', `--signal=${signal}`, st.cfg.containerName], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    p.stderr?.on('data', (b: Buffer) => log(b, st.name));
    p.on('error', (err: Error) => {
      log(fore(1) + `docker kill for ${st.name} failed: ${err.message}` + RES + '\n');
    });
  } else {
    const proc = st.proc!;
    log(fore(3) + `killing ${st.name} with ${signal}` + RES + '\n');
    try {
      // Negative pid signals the whole process group (see detached above).
      // A null pid must never reach here: kill(-0) would signal devstack's
      // own process group.
      if (proc.pid === null) throw new Error('no pid');
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.child.kill(signal);
      } catch {}
    }
  }
}

function dockerCreateStep(st: StageState): Step {
  const cfg = st.cfg as DockerStage;
  return (ctx) =>
    new Promise<void>((resolve, reject) => {
      /* This step deliberately ignores ctx.signal: canceling `docker create`
         mid-flight leaves the container in an unknown state.  It always runs
         to completion, and teardown deals with whatever exists afterward. */
      ctx.log(`creating container ${cfg.containerName}`);
      const p = spawn(
        'docker',
        [
          'container',
          'create',
          '--name',
          cfg.containerName,
          ...(cfg.dockerArgs ?? []),
          cfg.image,
          ...(cfg.cmd ?? []),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      p.stdout?.on('data', (b: Buffer) => {
        out += b.toString();
      });
      p.stderr?.on('data', (b: Buffer) => log(b, st.name));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`docker create exited with code ${code}`));
          return;
        }
        st.containerId = out.trim();
        trackContainer(st.containerId, cfg.containerName, normSignal(cfg.killSignal ?? 'SIGTERM'));
        resolve();
      });
    });
}

function dockerStartStep(st: StageState): Step {
  const cfg = st.cfg as DockerStage;
  return (ctx) =>
    new Promise<void>((resolve, reject) => {
      /* Runs to completion on abort, like dockerCreateStep: whether the
         container is running must be a settled fact by teardown time. */
      ctx.log(`starting container ${cfg.containerName}`);
      const p = spawn('docker', ['container', 'start', st.containerId], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      p.stderr?.on('data', (b: Buffer) => log(b, st.name));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`docker start exited with code ${code}`));
          return;
        }
        st.containerStarted = true;
        resolve();
      });
    });
}

async function dockerRm(st: StageState): Promise<void> {
  let force = false;
  if (st.containerStarted) {
    force = !(await runQuiet('docker', ['wait', st.containerId], 10_000));
    if (force) {
      log(` ----- docker wait for ${st.name} took too long, force-removing -----\n`, st.name);
    }
  }
  const rmArgs = force ? ['rm', '--force'] : ['rm'];
  await runQuiet('docker', [...rmArgs, st.containerId], 10_000);
  untrackContainer(st.containerId);
}

// run a command discarding output; resolves false on nonzero exit, spawn
// failure, or timeout (the process is SIGKILLed on timeout)
export function runQuiet(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

///////////////////////////////////
// built-in Step implementations //
///////////////////////////////////

// run a shell command as a step; it must exit 0
export function sh(command: string): Step {
  return commandStep(command, command);
}

// run an argv directly (no shell) as a step; it must exit 0
export function exec(...argv: string[]): Step {
  return commandStep(argv, argv.join(' '));
}

function commandStep(cmd: string | string[], cmdStr: string): Step {
  return (ctx) =>
    new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(new Error('canceled'));
        return;
      }
      ctx.log(fore(3) + `starting \`${cmdStr}\`` + RES);
      const start = Date.now();
      const options = {
        cwd: ctx.cwd,
        stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[],
        detached: true,
      };
      const child =
        typeof cmd === 'string'
          ? spawn(cmd, { ...options, shell: true })
          : spawn(cmd[0], cmd.slice(1), options);
      child.stdout?.on('data', (b: Buffer) => log(b, ctx.stream));
      child.stderr?.on('data', (b: Buffer) => log(b, ctx.stream));

      const onAbort = () => {
        try {
          if (child.pid === undefined) throw new Error('no pid');
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          try {
            child.kill('SIGTERM');
          } catch {}
        }
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      let settled = false;
      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        ctx.signal.removeEventListener('abort', onAbort);
        if (err === null) resolve();
        else reject(err);
      };

      child.on('error', (err: Error) => finish(err));
      child.on('close', (code) => {
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        if (ctx.signal.aborted) {
          ctx.log(fore(3) + ` ----- \`${cmdStr}\` canceled -----` + RES);
          finish(new Error('canceled'));
        } else if (code === 0) {
          ctx.log(fore(3) + ` ----- \`${cmdStr}\` complete! (${duration}s) -----` + RES);
          finish(null);
        } else {
          ctx.log(fore(1) + ` ----- \`${cmdStr}\` exited with ${code} -----` + RES);
          finish(new Error(`\`${cmdStr}\` exited with ${code}`));
        }
      });
    });
}

/* A step that succeeds once a tcp connection to the port succeeds.  Tries
   about every 20ms for up to 30 seconds, then fails the stage. */
export function connCheck(port: number, host = 'localhost'): Step {
  return async (ctx) => {
    // one attempt: true on connect, false on error or a 20ms timeout, and
    // false immediately on abort (the socket is destroyed either way)
    const attempt = () =>
      new Promise<boolean>((resolve) => {
        const sock = connect({ host, port });
        const finish = (ok: boolean) => {
          ctx.signal.removeEventListener('abort', onAbort);
          sock.destroy();
          resolve(ok);
        };
        const onAbort = () => finish(false);
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        sock.setTimeout(20);
        sock.on('timeout', () => finish(false));
        sock.on('error', () => finish(false));
        sock.on('connect', () => finish(true));
      });

    ctx.log(fore(3) + `waiting for ${host}:${port}` + RES);
    const deadline = Date.now() + 30_000;
    while (true) {
      if (ctx.signal.aborted) throw new Error('canceled');
      if (Date.now() > deadline) {
        ctx.log(fore(1) + ` ----- ${host}:${port} was not connectable within 30s -----` + RES);
        throw new Error(`${host}:${port} was not connectable within 30s`);
      }
      const started = Date.now();
      if (await attempt()) {
        ctx.log(fore(3) + ` ----- ${host}:${port} is connectable -----` + RES);
        return;
      }
      // rejects on abort, so a teardown never waits out the retry delay
      await sleep(Math.max(0, started + 20 - Date.now()), undefined, {
        signal: ctx.signal,
      });
    }
  };
}

/* A step that succeeds once a GET of the url returns a 2xx status.  Tries
   about every 250ms for up to 30 seconds, then fails the stage; each
   attempt gets one second before it is abandoned. */
export function httpCheck(url: string): Step {
  return async (ctx) => {
    ctx.log(fore(3) + `waiting for ${url}` + RES);
    const deadline = Date.now() + 30_000;
    let last = 'no response';
    while (true) {
      if (ctx.signal.aborted) throw new Error('canceled');
      if (Date.now() > deadline) {
        ctx.log(fore(1) + ` ----- ${url} was not healthy within 30s (${last}) -----` + RES);
        throw new Error(`${url} was not healthy within 30s (${last})`);
      }
      const started = Date.now();
      try {
        const res = await fetch(url, {
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(1_000)]),
        });
        res.body?.cancel().catch(() => {});
        if (res.ok) {
          ctx.log(fore(3) + ` ----- ${url} returned ${res.status} -----` + RES);
          return;
        }
        last = `status ${res.status}`;
      } catch (err) {
        last = errText(err);
      }
      // rejects on abort, so a teardown never waits out the retry delay
      await sleep(Math.max(0, started + 250 - Date.now()), undefined, {
        signal: ctx.signal,
      });
    }
  };
}

/* A step that succeeds once a line on a log stream matches the regex
   (by default, the stage's own stream).  Lines are matched as they grow, so
   a match can never be lost to an output-chunk boundary. */
export function logCheck(regex: RegExp, stream?: string): Step {
  // strip stateful flags so repeated tests can't skip matches
  const re = new RegExp(regex.source, regex.flags.replace(/[gy]/g, ''));
  return (ctx) =>
    new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(new Error('canceled'));
        return;
      }
      const watch = stream ?? ctx.stream;
      /* The announcements go to the console stream, and the waiting one is
         written before subscribing: a line on the watched stream containing
         the regex's own source text must never satisfy the check. */
      log(fore(3) + `${watch}: waiting for ${re}` + RES + '\n');

      let settled = false;
      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        logs.subscribers.delete(sub);
        ctx.signal.removeEventListener('abort', onAbort);
        if (err === null) {
          log(fore(3) + `${watch}: saw ${re}` + RES + '\n');
          resolve();
        } else {
          reject(err);
        }
      };
      const sub = (s: string, line: string) => {
        if (s !== watch || !re.test(line)) return;
        finish(null);
      };
      const onAbort = () => finish(new Error('canceled'));

      logs.subscribers.add(sub);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
}

//////////////////////////////////////
// begin command handling (hotkeys) //
//////////////////////////////////////

type Command = {
  cmdStr: string;
  child: ChildProcess;
  pid: number | null;
  start: number;
  killing: boolean;
  exited: boolean;
};

const commands = new Map<string, Command>();

function advanceCommands(): void {
  for (const key of target.commandKeyPresses.splice(0)) {
    const cfg = config.commands?.[key];
    if (cfg === undefined) continue;
    if (target.quitRequested) {
      log(fore(3) + 'ignoring command while we are quitting' + RES + '\n');
      continue;
    }
    if (commands.has(key)) {
      const cmdStr = commands.get(key)!.cmdStr;
      log(fore(3) + `command ${cmdStr} is still running, please wait...` + RES + '\n');
      continue;
    }
    commands.set(key, startCommand(cfg));
  }

  // sweep finished commands; quitting kills the stragglers
  for (const [key, cmd] of commands) {
    if (cmd.exited) {
      commands.delete(key);
    } else if (target.quitRequested && !cmd.killing) {
      cmd.killing = true;
      log(fore(3) + `killing \`${cmd.cmdStr}\`...` + RES + '\n');
      try {
        if (cmd.pid === null) throw new Error('no pid');
        process.kill(-cmd.pid, 'SIGTERM');
      } catch {
        try {
          cmd.child.kill('SIGTERM');
        } catch {}
      }
    }
  }
}

function startCommand(cfg: string | string[]): Command {
  const cmdStr = typeof cfg === 'string' ? cfg : cfg.join(' ');
  log(fore(3) + `starting \`${cmdStr}\`` + RES + '\n');
  const options = {
    stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[],
    detached: true,
  };
  const child =
    typeof cfg === 'string'
      ? spawn(cfg, { ...options, shell: true })
      : spawn(cfg[0], cfg.slice(1), options);
  const cmd: Command = {
    cmdStr,
    child,
    pid: child.pid ?? null,
    start: Date.now(),
    killing: false,
    exited: false,
  };

  child.stdout?.on('data', (b: Buffer) => log(b));
  child.stderr?.on('data', (b: Buffer) => log(b));

  const finish = (outcome: string, color: number) => {
    if (cmd.exited) return;
    cmd.exited = true;
    log(fore(color) + `\`${cmdStr}\` ${outcome}` + RES + '\n');
    schedule();
  };

  child.on('error', (err: Error) => finish(`failed to start: ${err.message}`, 1));
  child.on('close', (code, signal) => {
    const duration = ((Date.now() - cmd.start) / 1000).toFixed(2);
    if (cmd.killing) finish(`killed after ${duration}s`, 3);
    else if (code === 0) finish(`complete (${duration}s)`, 3);
    else if (signal !== null) finish(`killed by ${signal} (${duration}s)`, 1);
    else finish(`failed with ${code} (${duration}s)`, 1);
  });

  return cmd;
}

//////////////////
// log tracking //
//////////////////

export type StreamItem = {
  // which log stream the line belongs to
  stream: string;
  /* Arrival order, and the display order: logs.items stays sorted by seq.
     Unterminated lines take a fresh seq (and move to the end of the
     timeline) as they grow, so the active line floats to the bottom.
     (Wall-clock time can't order the display: lines logged in the same
     millisecond tie.) */
  seq: number;
  // when the line last changed
  time: number;
  // sanitized text, no line terminator
  line: string;
  // render's cached wrap measurement (see measureLine)
  wrap?: WrapInfo;
};

// per-stream chunk-assembly state
export type LogStream = {
  // unsanitized text of the trailing unterminated line
  raw: string;
  // the item holding that unterminated line, already in logs.items
  open: StreamItem | null;
  // the last chunk ended with \r: swallow a leading \n on the next chunk
  swallowLF: boolean;
  // carries multi-byte utf8 state across chunk boundaries
  decoder: TextDecoder;
};

export const logs = {
  // every line of every stream, always sorted by seq
  items: [] as StreamItem[],
  streams: {} as Record<string, LogStream>,
  // bumped on every mutation; advanceRender repaints when it changes
  version: 0,
  // the source of StreamItem.seq values
  seq: 0,
  // called with (stream, line) whenever a line is created or grows;
  // logCheck() steps subscribe here and unsubscribe when they settle
  subscribers: new Set<(stream: string, line: string) => void>(),
};

function getStream(name: string): LogStream {
  let s = logs.streams[name];
  if (!s) {
    s = { raw: '', open: null, swallowLF: false, decoder: new TextDecoder() };
    logs.streams[name] = s;
  }
  return s;
}

// is this line still growing?  (completed lines never change)
function isOpen(item: StreamItem): boolean {
  return logs.streams[item.stream].open === item;
}

// append process output or an internal message to a log stream
export function log(data: string | Uint8Array, stream = 'console'): void {
  // mirror every stream, raw, to <tempDir>/<stream>.log; best-effort only
  if (tracker.dir !== '') {
    try {
      fs.appendFileSync(path.join(tracker.dir, stream + '.log'), data);
    } catch {}
  }
  const s = getStream(stream);
  let text = typeof data === 'string' ? data : s.decoder.decode(data, { stream: true });
  if (s.swallowLF && text.startsWith('\n')) text = text.slice(1);
  s.swallowLF = false;
  if (text === '') return;
  s.swallowLF = text.endsWith('\r');
  // \n, \r, and \r\n all terminate a line, so bare-\r progress-bar frames
  // each become their own line instead of overwriting anything
  const parts = text.split(/\r\n|[\r\n]/);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      // a terminator sits between parts[i-1] and parts[i]
      if (s.open === null) {
        logs.items.push({ stream, seq: ++logs.seq, time: Date.now(), line: '' });
      }
      s.open = null;
      s.raw = '';
    }
    if (parts[i] !== '') {
      if (s.open === null) {
        s.open = { stream, seq: ++logs.seq, time: Date.now(), line: '' };
        logs.items.push(s.open);
      } else if (logs.items[logs.items.length - 1] !== s.open) {
        // an older line is growing: move it to the end of the timeline so
        // logs.items stays seq-sorted when it takes a fresh seq below
        logs.items.splice(logs.items.lastIndexOf(s.open), 1);
        logs.items.push(s.open);
      }
      const item = s.open;
      s.raw += parts[i];
      item.line = sanitizeLine(s.raw);
      item.seq = ++logs.seq;
      item.time = Date.now();
      item.wrap = undefined;
      for (const cb of logs.subscribers) cb(stream, item.line);
    }
  }
  logs.version++;
  schedule();
}

/* Sanitize one raw log line for storage: SGR color sequences pass through,
   tabs expand to 8-column stops (measured from the line's start), and all
   other escape sequences and control characters are dropped.  An incomplete
   escape at the end of the string is dropped too; unterminated lines are
   re-sanitized from raw text as they grow, so it comes back once complete. */
function sanitizeLine(raw: string): string {
  let out = '';
  let col = 0;
  let i = 0;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c === 0x1b) {
      const esc = scanEscape(raw, i);
      if (esc === null) break; // incomplete escape at end of string
      if (esc.sgr) out += raw.slice(i, esc.end);
      i = esc.end;
      continue;
    }
    if (c === 0x09) {
      const n = 8 - (col % 8);
      out += ' '.repeat(n);
      col += n;
      i++;
      continue;
    }
    if (c < 0x20 || c === 0x7f) {
      i++;
      continue;
    }
    const cp = raw.codePointAt(i)!;
    out += String.fromCodePoint(cp);
    col += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

// Scan the escape sequence starting at raw[i] (an ESC).  Returns its end
// (exclusive) and whether it is an SGR sequence, or null if the sequence
// runs off the end of the string.
function scanEscape(raw: string, i: number): { end: number; sgr: boolean } | null {
  const kind = raw[i + 1];
  if (kind === undefined) return null;
  if (kind === '[') {
    // CSI: parameter and intermediate bytes, then one final byte 0x40-0x7e
    let j = i + 2;
    while (j < raw.length && raw.charCodeAt(j) < 0x40) j++;
    if (j >= raw.length) return null;
    return { end: j + 1, sgr: raw[j] === 'm' };
  }
  if (kind === ']') {
    // OSC: terminated by BEL or by ESC \
    let j = i + 2;
    while (j < raw.length) {
      if (raw.charCodeAt(j) === 0x07) return { end: j + 1, sgr: false };
      if (raw.charCodeAt(j) === 0x1b) {
        if (j + 1 >= raw.length) return null;
        return { end: j + 2, sgr: false };
      }
      j++;
    }
    return null;
  }
  if ('()#%*+'.includes(kind)) {
    // three-byte sequences (charset selection and friends)
    if (i + 2 >= raw.length) return null;
    return { end: i + 3, sgr: false };
  }
  return { end: i + 2, sgr: false };
}

///////////////////////////
// log wrap calculations //
///////////////////////////

// approximate wcwidth: combining and zero-width characters are 0, east-asian
// wide/fullwidth blocks and emoji are 2, everything else is 1
export function charWidth(cp: number): number {
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space and joiners
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // hangul jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // cjk radicals .. cjk punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana .. cjk compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // cjk extension a
    (cp >= 0x4e00 && cp <= 0x9fff) || // cjk unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // cjk compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // cjk compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // cjk extensions b+
  ) {
    return 2;
  }
  return 1;
}

// printable width of a sanitized string
export function strWidth(s: string): number {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      i = s.indexOf('m', i) + 1;
      continue;
    }
    const cp = s.codePointAt(i)!;
    w += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return w;
}

export type WrapInfo = {
  // the terminal width this measurement is valid for
  width: number;
  // how many visual rows the line occupies (>= 1)
  rows: number;
  /* For k >= 1, visual row k of the line begins at string offset
     starts[k-1].at, and starts[k-1].sgr replays the color state active
     there, for painting the line from that row down. */
  starts: { at: number; sgr: string }[];
};

function measureLine(line: string, width: number): WrapInfo {
  const w = Math.max(1, width);
  const starts: { at: number; sgr: string }[] = [];
  let sgr = '';
  let col = 0;
  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      const end = line.indexOf('m', i) + 1;
      sgr = sgrCombine(sgr, line.slice(i, end));
      i = end;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const cw = charWidth(cp);
    if (col + cw > w) {
      // the terminal defers wrapping until the next printable character, so
      // a line of exactly `width` columns occupies a single row
      starts.push({ at: i, sgr });
      col = 0;
    }
    col += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  return { width, rows: starts.length + 1, starts };
}

/* Fold one SGR sequence into a replay string.  Replaying every sequence
   since the most recent full reset, in order, reproduces the terminal's
   color state; a sequence containing parameter 0 (or empty) is such a
   reset, and stands alone. */
function sgrCombine(prev: string, seq: string): string {
  const params = seq.slice(2, -1).split(';');
  if (!params.some((p) => p === '' || Number(p) === 0)) return prev + seq;
  if (params.every((p) => p === '' || Number(p) === 0)) return '';
  return seq;
}

function wrapInfo(item: StreamItem, width: number): WrapInfo {
  if (item.wrap?.width !== width) {
    item.wrap = measureLine(item.line, width);
  }
  return item.wrap;
}

///////////////////////////
// view: our terminal ui //
///////////////////////////

export const RES = '\x1b[0m';

export function fore(n: number): string {
  return `\x1b[38;5;${n}m`;
}

export function back(n: number): string {
  return `\x1b[48;5;${n}m`;
}

// 24-bit color from "#rrggbb"
function rgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r};${g};${b}`;
}

export function foreHex(hex: string): string {
  return `\x1b[38;2;${rgb(hex)}m`;
}

export function backHex(hex: string): string {
  return `\x1b[48;2;${rgb(hex)}m`;
}

function place(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export const view = {
  // terminal size; 0 until initTerminal() runs
  cols: 0,
  rows: 0,
  // which log streams are drawn
  activeStreams: new Set<string>(),
  /* Scroll position.  null follows the tail.  Otherwise the top row of the
     viewport shows anchor.item's wrap row containing anchor.offset, and the
     view stays pinned to that content while new lines arrive.  The offset
     is a string offset so a resize re-derives the wrap row: the anchored
     byte stays on the top row even though the wrap points moved.  Only
     scroll events replace the anchor, so an anchor whose stream is toggled
     off survives, hidden, until the stream comes back. */
  anchor: null as null | { item: StreamItem; offset: number },
  // scroll keys accumulate here; advanceRender applies them before painting
  scrollDelta: 0,
  markerColor: 0,
  // what was last painted, so unchanged wakeups cost nothing
  paintedBar: '',
  paintedVersion: -1,
  // force a log repaint (resize, scroll, stream toggles)
  dirty: true,
  // ctrl-l: re-assert the whole screen setup and repaint from scratch
  hardClear: false,
  /* The terminal is currently in devstack mode (altscreen, raw input).
     Set by initTerminal(), cleared by restoreTerminal(), which makes the
     restore once-only across the quit/force-quit/panic paths. */
  termConfigured: false,
};

// display order of log streams: devstack's own console stream, then stages
function streamNames(): string[] {
  return ['console', ...status.stages.map((s) => s.name)];
}

// the render sub-advancer; parks until there is a terminal and a change
function advanceRender(): void {
  if (opts.oneshot) {
    renderOneshot();
    return;
  }
  // paint only while the terminal is in devstack mode and usably sized
  if (!view.termConfigured || view.cols < 4 || view.rows < 4) return;
  let out = '';
  if (view.hardClear) {
    view.hardClear = false;
    // re-read the size and re-assert the screen setup: this recovers from a
    // missed resize or from a child's stray output corrupting the terminal
    view.cols = process.stdout.columns;
    view.rows = process.stdout.rows;
    view.paintedBar = '';
    view.dirty = true;
    out += `\x1b[2J\x1b[?25l\x1b[3;${view.rows}r`;
  }
  const bar = renderBar();
  if (bar !== view.paintedBar) {
    view.paintedBar = bar;
    out += bar;
  }
  if (view.dirty || logs.version !== view.paintedVersion) {
    view.dirty = false;
    view.paintedVersion = logs.version;
    applyScroll();
    out += renderLogs();
  }
  if (out) process.stdout.write(out);
}

function renderBar(): string {
  const cols = view.cols;
  // phaselock colors on the status bar
  const idle = foreHex('#2ee6a8') + backHex('#0a1f18');
  const active = foreHex('#0a1f18') + backHex('#2ee6a8');
  const failed = foreHex('#000000') + backHex('#d00000');

  const names = ['dead', ...status.stages.map((s) => s.name)];
  // crashed paints red; anything else not fully down (standing up, running,
  // or tearing down) paints as active
  const colors = status.stages.map((st) => (st.crashed ? failed : isFullyDown(st) ? idle : active));
  // only when nothing is running is the DEAD state highlighted
  const allDown = colors.every((c) => c === idle);

  let bar1 = 'state: ';
  let len1 = bar1.length;
  for (let i = 0; i < names.length; i++) {
    const color = i === 0 ? (allDown ? active : idle) : colors[i - 1];
    const binding = i === 0 ? '  (`)' : `  (${i})`;
    const post = i === effectiveTarget() ? '< ' : '  ';
    bar1 += binding + color + names[i].toUpperCase() + idle + post;
    len1 += 7 + strWidth(names[i]);
  }
  bar1 += ' '.repeat(Math.max(0, cols - len1));

  const bindings = '~!@#$%^&*(';
  let bar2 = 'logs: ';
  let len2 = bar2.length;
  const streams = streamNames();
  for (let i = 0; i < streams.length; i++) {
    const binding = i < bindings.length ? `(${bindings[i]})` : '   ';
    const color = view.activeStreams.has(streams[i]) ? active : idle;
    bar2 += binding + color + streams[i].toUpperCase() + idle + '    ';
    len2 += 7 + strWidth(streams[i]);
  }
  bar2 += ' '.repeat(Math.max(0, cols - len2));

  // each row is positioned explicitly, so bar1's padding never has to line
  // up exactly with the terminal width for bar2 to land on row 2
  return place(1, 1) + idle + bar1 + place(2, 1) + foreHex('#9fbbc5') + bar2 + RES;
}

// ─── the timeline cursor: positions in logs.items, filtered by stream ───

// locate an item in logs.items by binary search on its seq
function itemIndex(item: StreamItem): number {
  let lo = 0;
  let hi = logs.items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (logs.items[mid].seq === item.seq) return mid;
    if (logs.items[mid].seq < item.seq) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// nearest index at-or-before/at-or-after i whose stream is displayed
function prevVisible(i: number): number {
  for (; i >= 0; i--) {
    if (view.activeStreams.has(logs.items[i].stream)) return i;
  }
  return -1;
}
function nextVisible(i: number): number {
  for (; i < logs.items.length; i++) {
    if (view.activeStreams.has(logs.items[i].stream)) return i;
  }
  return -1;
}

// string offset where wrap row k of a measured line begins
function rowStart(info: WrapInfo, k: number): number {
  return k === 0 ? 0 : info.starts[k - 1].at;
}

// the wrap row containing string offset `at`
function rowOfOffset(info: WrapInfo, at: number): number {
  let k = 0;
  while (k < info.starts.length && info.starts[k].at <= at) k++;
  return k;
}

// count visible wrap rows from item i, row k, downward, up to `limit`
function rowsFrom(i: number, k: number, limit: number): number {
  let rows = 0;
  while (i >= 0 && rows < limit) {
    rows += wrapInfo(logs.items[i], view.cols).rows - k;
    k = 0;
    i = nextVisible(i + 1);
  }
  return rows;
}

// the (item index, wrap row) on the top row when following the tail, or
// null when the visible content fits on the screen
function followingTop(): { i: number; k: number } | null {
  const width = view.cols;
  const H = view.rows - 2;
  let below = 0;
  let i = prevVisible(logs.items.length - 1);
  while (i >= 0) {
    const info = wrapInfo(logs.items[i], width);
    if (below + info.rows >= H) return { i, k: below + info.rows - H };
    below += info.rows;
    i = prevVisible(i - 1);
  }
  return null;
}

/* Resolve the anchor to the (item index, wrap row) shown on the top row,
   under the current width and stream set.  Read-only: the anchor itself
   changes only on actual scroll events (applyScroll, followTail).  Hiding
   the anchored line's stream slides the *display* to the next visible line
   while the anchor keeps pointing at the original content, so re-enabling
   the stream restores the exact view. */
function resolveAnchor(): { i: number; k: number } | null {
  const a = view.anchor;
  if (a === null) return null;
  const i = itemIndex(a.item);
  if (i < 0) {
    // unreachable while the buffer is never pruned; drop the stale anchor
    view.anchor = null;
    return null;
  }
  if (!view.activeStreams.has(a.item.stream)) {
    const j = nextVisible(i + 1);
    if (j < 0) return null; // nothing visible at or below; show the tail
    return { i: j, k: 0 };
  }
  // a resize may have moved the wrap points; show the row that now
  // contains the anchored byte
  const k = rowOfOffset(wrapInfo(a.item, view.cols), a.offset);
  return { i, k };
}

// apply the accumulated scroll keys to the anchor, in visual rows
function applyScroll(): void {
  let delta = view.scrollDelta;
  view.scrollDelta = 0;
  if (delta === 0) return;
  const width = view.cols;

  let pos = resolveAnchor();
  if (pos === null) {
    if (delta <= 0) return; // already at the tail
    pos = followingTop();
    if (pos === null) return; // everything fits; nowhere to scroll
  }
  let { i, k } = pos;

  for (; delta > 0; delta--) {
    // up one visual row
    if (k > 0) {
      k--;
    } else {
      const j = prevVisible(i - 1);
      if (j < 0) break; // top of the buffer
      i = j;
      k = wrapInfo(logs.items[i], width).rows - 1;
    }
  }
  for (; delta < 0; delta++) {
    // down one visual row
    if (k < wrapInfo(logs.items[i], width).rows - 1) {
      k++;
    } else {
      const j = nextVisible(i + 1);
      if (j < 0) break; // the follow collapse below handles the tail
      i = j;
      k = 0;
    }
  }

  // scrolling on the still-growing tail line would chase it as it re-seqs;
  // anchor content that can no longer change
  let item = logs.items[i];
  if (isOpen(item) && k === 0) {
    const j = prevVisible(i - 1);
    if (j >= 0) {
      i = j;
      item = logs.items[i];
      k = wrapInfo(item, width).rows - 1;
    }
  }

  // landing with less than a screenful below returns to following the tail
  if (rowsFrom(i, k, view.rows - 2) < view.rows - 2) {
    view.anchor = null;
    return;
  }
  view.anchor = { item, offset: rowStart(wrapInfo(item, width), k) };
}

/* Paint the log viewport.

   Lines are written whole wherever possible and the terminal wraps them
   naturally, so selecting or copy/pasting a wrapped line behaves like one
   line.  Only the lines crossing the viewport's top and bottom edges get
   sliced at a wrap boundary, and the top slice is prefixed with the SGR
   state active at that offset so colors survive the cut. */
function renderLogs(): string {
  const width = view.cols;
  const H = view.rows - 2;

  // the top of the viewport: the anchor, or a screenful above the tail
  let top = resolveAnchor();
  if (top === null) {
    top = followingTop();
    if (top === null) {
      // everything fits on one screen; paint from the beginning
      const j = nextVisible(0);
      top = j < 0 ? null : { i: j, k: 0 };
    }
  }

  const segs: string[] = [];
  if (top !== null) {
    let { i, k } = top;
    let rows = 0;
    while (i >= 0 && rows < H) {
      const item = logs.items[i];
      const info = wrapInfo(item, width);
      const take = Math.min(info.rows - k, H - rows);
      const from = rowStart(info, k);
      const sgr = k === 0 ? '' : info.starts[k - 1].sgr;
      const endRow = k + take;
      const to = endRow >= info.rows ? item.line.length : info.starts[endRow - 1].at;
      segs.push(RES + sgr + item.line.slice(from, to));
      rows += take;
      k = 0;
      i = nextVisible(i + 1);
    }
  }

  let out = place(3, 1) + '\x1b[J' + segs.join('\r\n');
  if (view.anchor !== null) {
    out += place(view.rows, 1) + '\x1b[2K' + foreHex('#ffed4e') + "(scrolled; 'x' to follow)" + RES;
  }
  return out;
}

//////////////////
// oneshot mode //
//////////////////

const oneshot = {
  // the target in effect when the run started; deviation means failure
  firstTarget: -1,
  up: false,
  failing: false,
};

// print when we're up, and quit when any stage crashes
function advanceOneshot(): void {
  if (oneshot.failing) return;

  if (oneshot.firstTarget < 0) oneshot.firstTarget = target.targetIdx;
  const t = oneshot.firstTarget;

  const crashed = status.stages.some((s) => s.crashed);
  if (target.targetIdx !== t || crashed) {
    oneshot.failing = true;
    process.stderr.write('devstack is failing\n');
    target.quitRequested = true;
    // HACK: we're inside advance() but we need to restart it
    schedule();
    return;
  }

  // a stage being up implies everything below it stood up first
  if (!oneshot.up && (t === 0 || status.stages[t - 1].up)) {
    oneshot.up = true;
    process.stderr.write('devstack is up\n');
  }
}

/* The oneshot emit cursor: every line with seq <= seenSeq has been written
   out or parked in skipped -- open lines passed over while waiting for
   their terminator, at most one per stream.  The cursor is a seq watermark,
   which makes it immune to log() moving a grown line to the end of the
   timeline: the move re-seqs the line above the watermark, so it is
   re-encountered; one that completes in place is caught by the sweep in
   renderOneshot. */
const oneshotEmit = {
  seenSeq: 0,
  skipped: new Set<StreamItem>(),
};

/* Write log lines to stdout, each prefixed with their stream name.
   Unterminated lines are held back until their terminator arrives, so
   partial lines from different streams never interleave; flush emits them
   anyway, for the final write before exiting. */
function renderOneshot(flush = false): void {
  if (!flush && logs.version === view.paintedVersion) return;
  view.paintedVersion = logs.version;
  const out: { seq: number; text: string }[] = [];
  const emit = (item: StreamItem) => {
    // reset colors per line so unbalanced SGR can't bleed into the prefix
    const tail = item.line.includes('\x1b') ? RES : '';
    out.push({ seq: item.seq, text: `${item.stream}: ${item.line}${tail}\n` });
  };
  // the unseen items are a suffix of the seq-sorted timeline
  let start = logs.items.length;
  while (start > 0 && logs.items[start - 1].seq > oneshotEmit.seenSeq) start--;
  for (let i = start; i < logs.items.length; i++) {
    const item = logs.items[i];
    oneshotEmit.seenSeq = item.seq;
    if (!flush && isOpen(item)) {
      oneshotEmit.skipped.add(item);
      continue;
    }
    oneshotEmit.skipped.delete(item);
    emit(item);
  }
  for (const item of [...oneshotEmit.skipped]) {
    if (!flush && isOpen(item)) continue;
    oneshotEmit.skipped.delete(item);
    emit(item);
  }
  if (out.length === 0) return;
  out.sort((a, b) => a.seq - b.seq);
  process.stdout.write(out.map((o) => o.text).join(''));
}

//////////////////
// key handling //
//////////////////

// undecoded input bytes, held until an escape sequence completes
let inputBuf = '';

// feed keyboard bytes (or startupInput) through the key decoder
export function feedInput(data: string | Uint8Array): void {
  inputBuf += typeof data === 'string' ? data : Buffer.from(data).toString('latin1');
  let key;
  while (inputBuf.length > 0 && (key = scanKey(inputBuf)) !== null) {
    inputBuf = inputBuf.slice(key.length);
    handleKey(key);
  }
  schedule();
}

/* Scan one key at the front of buf: a plain character, or a complete escape
   sequence kept whole so arrow keys arrive as single keys.  Returns null
   when buf holds the start of an escape sequence that has not fully
   arrived; a lone ESC therefore dispatches nothing until more bytes come. */
function scanKey(buf: string): string | null {
  if (buf[0] !== '\x1b') return buf[0];
  if (buf.length < 2) return null;
  if (buf[1] === '[') {
    // CSI: parameter bytes, then one final byte in 0x40-0x7e
    let j = 2;
    while (j < buf.length && buf.charCodeAt(j) < 0x40) j++;
    if (j >= buf.length) return null;
    return buf.slice(0, j + 1);
  }
  if (buf[1] === 'O') {
    // SS3, how some terminals send arrow keys
    if (buf.length < 3) return null;
    return buf.slice(0, 3);
  }
  // alt+key and other two-byte escapes; dispatched (and reported) as unknown
  return buf.slice(0, 2);
}

// If a target is crashed: restart it.  Otherwise set it as the target state.
export function setTargetOrRestart(idx: number): void {
  if (target.quitRequested) return;
  if (idx > status.stages.length) return;
  if (idx > 0 && status.stages[idx - 1].crashed) {
    status.stages[idx - 1].wantDown = true;
    return;
  }
  target.targetIdx = idx;
}

function handleKey(key: string): void {
  // 0-9 and backtick: choose a target stage (or restart a crashed one)
  const digit = '0123456789'.indexOf(key);
  if (digit >= 0 || key === '`') {
    setTargetOrRestart(Math.max(0, digit));
    return;
  }
  // shifted 0-9: toggle log streams
  const shift = ')!@#$%^&*('.indexOf(key);
  if (shift >= 0 || key === '~') {
    toggleStream(Math.max(0, shift));
    return;
  }
  // user-configured command hotkeys, which may shadow the default keys below
  if (config.commands && Object.hasOwn(config.commands, key)) {
    target.commandKeyPresses.push(key);
    return;
  }
  switch (key) {
    case '\x03': // ctrl-c
    case 'q':
      requestQuit();
      return;
    case 'k':
    case '\x1b[A': // up arrow
    case '\x1bOA':
      scrollBy(1);
      return;
    case 'j':
    case '\x1b[B': // down arrow
    case '\x1bOB':
      scrollBy(-1);
      return;
    case 'b':
    case '\x1b[5~': // page up
      scrollBy(pageRows());
      return;
    case 'f':
    case '\x1b[6~': // page down
      scrollBy(-pageRows());
      return;
    case 'u':
      scrollBy(Math.ceil(pageRows() / 2));
      return;
    case 'd':
      scrollBy(-Math.ceil(pageRows() / 2));
      return;
    case 'x':
      followTail();
      return;
    case '\x0c': // ctrl-l: redraw the screen unconditionally
      view.hardClear = true;
      view.dirty = true;
      return;
    case ' ':
      marker();
      return;
  }
  log(fore(9) + `"${printableKey(key)}" is not a known shortcut` + RES + '\n');
}

// control characters rendered caret-style, e.g. ESC as ^[
function printableKey(key: string): string {
  let out = '';
  for (const ch of key) {
    const c = ch.charCodeAt(0);
    out += c < 0x20 ? '^' + String.fromCharCode(c + 0x40) : ch;
  }
  return out;
}

// the log viewport height, as the unit for page-wise scrolling
function pageRows(): number {
  return Math.max(1, view.rows - 2);
}

function scrollBy(delta: number): void {
  view.scrollDelta += delta;
  view.dirty = true;
}

// return to following the tail
function followTail(): void {
  view.anchor = null;
  view.scrollDelta = 0;
  view.dirty = true;
}

/* Toggling a stream deliberately leaves the scroll anchor alone: scroll to
   an error in a quiet stream, then re-enable a noisy one, and the view
   stays put while the noisy lines interleave around it. */
function toggleStream(idx: number): void {
  const names = streamNames();
  if (idx >= names.length) return;
  const name = names[idx];
  if (view.activeStreams.has(name)) {
    view.activeStreams.delete(name);
  } else {
    view.activeStreams.add(name);
  }
  view.dirty = true;
}

// emit a visual separator with a timestamp, cycling through colors
export function marker(): void {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const t =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const color = ((view.markerColor + 3) % 5) + 10;
  view.markerColor++;
  log(fore(color) + `-- ${Date.now() / 1000} -- ${t} --------------` + RES + '\n');
}

export function requestQuit(): void {
  if (target.quitRequested) {
    killEverything();
    restoreTerminal();
    console.error('devstack quit forcibly');
    process.exit(130);
  }
  target.quitRequested = true;
  log('quitting...\n');
}

//////////////////////////////////
// terminal settings management //
//////////////////////////////////

/* Put the terminal in devstack mode: raw keyboard input, hidden cursor,
   cleared screen, and a scroll region that reserves rows 1 and 2 for the status
   bar.  Called once at startup, after status.stages is populated. */
function initTerminal(): void {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', feedInput);
  view.cols = process.stdout.columns;
  view.rows = process.stdout.rows;
  process.stdout.on('resize', () => {
    view.cols = process.stdout.columns;
    view.rows = process.stdout.rows;
    process.stdout.write(`\x1b[3;${view.rows}r`);
    view.dirty = true;
    schedule();
  });
  view.activeStreams = new Set(streamNames());
  view.termConfigured = true;
  // enter the alternate screen, clear it, hide the cursor, and reserve
  // rows 1-2 from scrolling
  process.stdout.write(`\x1b[?1049h\x1b[2J\x1b[?25l\x1b[3;${view.rows}r`);
  view.dirty = true;
  schedule();
}

// undo initTerminal(); safe to call in any state, including mid-panic
function restoreTerminal(): void {
  if (!view.termConfigured) return;
  view.termConfigured = false;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {}
  // stop holding the event loop open, so a finished quit can exit
  process.stdin.pause();
  // release the scroll region, reset colors, show the cursor, and leave the
  // alternate screen, which restores the shell's previous contents
  process.stdout.write(`\x1b[r${RES}\x1b[?25h\x1b[?1049l`);
}

///////////////////////////////////////////
// process tracking and instance locking //
///////////////////////////////////////////

// running.json entries; snake_case keys are the on-disk standard
type TrackedProc =
  | { pid: number; match_args: string; kill_signal: string }
  | { container_id: string; container_name: string; kill_signal: string };

const tracker = {
  // set by initStateDir(); empty disables tracking (should never happen)
  dir: '',
  running: [] as TrackedProc[],
  // the instance lock: an EXCLUSIVE transaction held for our lifetime
  lockDb: null as DatabaseSync | null,
};

function initStateDir(): void {
  tracker.dir = config.tempDir ?? '/tmp/devstack';
  fs.mkdirSync(tracker.dir, { recursive: true });
}

function trackerPath(): string {
  return path.join(tracker.dir, 'running.json');
}

// atomic write, so a crash mid-update can't corrupt the recovery data
function trackerWrite(): void {
  if (tracker.dir === '') return;
  try {
    fs.writeFileSync(trackerPath() + '.tmp', JSON.stringify(tracker.running));
    fs.renameSync(trackerPath() + '.tmp', trackerPath());
  } catch (err) {
    log(fore(1) + `failed to update running.json: ${errText(err)}` + RES + '\n');
  }
}

function trackPid(pid: number | null, matchArgs: string, killSignal: string): void {
  if (pid === null) return;
  tracker.running.push({ pid, match_args: matchArgs, kill_signal: killSignal });
  trackerWrite();
}

function untrackPid(pid: number | null): void {
  if (pid === null) return;
  tracker.running = tracker.running.filter((p) => !('pid' in p) || p.pid !== pid);
  trackerWrite();
}

function trackContainer(containerId: string, containerName: string, killSignal: string): void {
  tracker.running.push({
    container_id: containerId,
    container_name: containerName,
    kill_signal: killSignal,
  });
  trackerWrite();
}

function untrackContainer(containerId: string): void {
  tracker.running = tracker.running.filter(
    (p) => !('container_id' in p) || p.container_id !== containerId,
  );
  trackerWrite();
}

/* One devstack per tempDir, arbitrated by the kernel: an open EXCLUSIVE
   sqlite transaction holds an fcntl lock on lock.db for our whole lifetime,
   and the kernel releases it on any death -- there is no stale-lock state,
   nothing to clean up, and no race.  Any devstack implementation, in any
   language with sqlite, cooperates by honoring the same convention. */
function acquireLock(): void {
  tracker.lockDb = new DatabaseSync(path.join(tracker.dir, 'lock.db'));
  try {
    tracker.lockDb.exec('BEGIN EXCLUSIVE');
  } catch {
    process.stderr.write(`another devstack is already running for ${tracker.dir}\n`);
    process.exit(1);
  }
}

/* Startup pass over a previous run's running.json: any process or container
   a crashed or force-quit devstack left behind gets killed before this
   run spawns anything that could collide with it.  Deliberately synchronous
   (spawnSync): the whole point is to finish before the first stage starts. */
function recoverOrphans(): void {
  let old: TrackedProc[];
  try {
    old = JSON.parse(fs.readFileSync(trackerPath(), 'utf8'));
  } catch {
    return; // no leftover file, or an unreadable one: nothing to recover
  }
  if (!Array.isArray(old)) return;
  // newest first, mirroring teardown order
  for (const entry of [...old].reverse()) {
    if ('pid' in entry) recoverPid(entry);
    else if ('container_id' in entry) recoverContainer(entry);
  }
  trackerWrite(); // tracker.running is empty: the slate is clean
}

function recoverPid(entry: { pid: number; match_args: string; kill_signal: string }): void {
  const ps = spawnSync('ps', ['-p', String(entry.pid), '-o', 'command'], {
    encoding: 'utf8',
  });
  if (ps.status !== 0 || typeof ps.stdout !== 'string') return; // pid is gone
  // skip the ps header; there is no cross-platform way to not print it
  const lines = ps.stdout.trim().split('\n');
  if (lines.length < 2) return;
  const found = lines[1].trim();
  if (!found.includes(entry.match_args)) {
    // the pid was recycled by an unrelated process; better not to kill it
    log(`chose not to kill pid ${entry.pid} whose args don't match ` + `'${entry.match_args}'\n`);
    return;
  }
  try {
    try {
      process.kill(-entry.pid, normSignal(entry.kill_signal));
    } catch {
      process.kill(entry.pid, normSignal(entry.kill_signal));
    }
    log(
      `killed old pid ${entry.pid} running '${entry.match_args}' ` + `with ${entry.kill_signal}\n`,
    );
  } catch {
    // it died between the check and the kill
  }
}

function recoverContainer(entry: {
  container_id: string;
  container_name: string;
  kill_signal: string;
}): void {
  const ps = spawnSync(
    'docker',
    ['ps', '-a', '--filter', `id=${entry.container_id}`, '--format', '{{.State}}'],
    { encoding: 'utf8' },
  );
  const state = (ps.stdout ?? '').trim();
  if (ps.status !== 0 || state === '') return; // no docker, or container gone
  if (state !== 'created' && state !== 'exited') {
    spawnSync('docker', ['kill', `--signal=${normSignal(entry.kill_signal)}`, entry.container_id], {
      stdio: 'ignore',
    });
    spawnSync('docker', ['wait', entry.container_id], {
      stdio: 'ignore',
      timeout: 10_000,
    });
  }
  spawnSync('docker', ['rm', entry.container_id], { stdio: 'ignore' });
  log(`killed old docker container ${entry.container_name}\n`);
}

////////////////////////////////////////
// signal and uncaught error handling //
////////////////////////////////////////

function installProcessHandlers(): void {
  /* External terminate/interrupt takes the same path as pressing q, so a
     second signal force-quits.  In the TUI, ctrl-c arrives as the \x03 key
     (raw mode), so SIGINT here means oneshot mode or an outside kill. */
  const onQuitSignal = () => {
    requestQuit();
    schedule();
  };
  process.on('SIGTERM', onQuitSignal);
  process.on('SIGINT', onQuitSignal);
  // the terminal went away; tear the cluster down rather than orphan it
  process.on('SIGHUP', onQuitSignal);

  // redraw when terminal changes
  process.on('SIGWINCH', () => {
    view.hardClear = true;
    schedule();
  });

  // a throw from an event adapter runs outside schedule()'s try/catch, but
  // must still restore the terminal and kill the children
  process.on('uncaughtException', (err) => panic(err));
  process.on('unhandledRejection', (err) => panic(err));

  // a closed output pipe (`devstack --oneshot | head`) raises EPIPE on
  // write; swallow it and let the reader's death reach us as a signal
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
}

///////////////////
// main function //
///////////////////

function parseArgs(argv: string[]): { targetStage?: string } {
  const out: { targetStage?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-1' || arg === '--oneshot') {
      opts.oneshot = true;
    } else if (arg === '--target-stage') {
      if (i + 1 >= argv.length) {
        process.stderr.write('--target-stage requires a value\n');
        process.exit(1);
      }
      out.targetStage = argv[++i];
    } else if (arg.startsWith('--target-stage=')) {
      out.targetStage = arg.slice('--target-stage='.length);
    } else if (arg === '-h' || arg === '--help') {
      usage(process.stdout);
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      usage(process.stderr);
      process.exit(1);
    }
  }
  return out;
}

// the fields of the two stage-config union members
const COMMON_FIELDS = ['cmd', 'pre', 'post', 'killSignal'];
const DOCKER_FIELDS = ['containerName', 'dockerArgs', 'image'];
const PROCESS_FIELDS = ['cwd', 'env'];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

// a Step, or an array of Steps (the shapes toSteps() accepts)
function isStepish(v: unknown): boolean {
  return typeof v === 'function' || (Array.isArray(v) && v.every((x) => typeof x === 'function'));
}

/* Field-level stage validation, since configs run type-stripped (`node
   devstack.mts`) and never meet tsc.  Any docker-only field commits the
   stage to the docker side of the union, so an `image` with a forgotten
   `containerName` errors here instead of running as a process stage. */
function validateStage(name: string, stage: ProcessStage | DockerStage, errors: string[]): void {
  const bad = (msg: string) => errors.push(`stage ${name}: ${msg}`);
  if (typeof stage !== 'object' || stage === null) {
    bad('must be an object');
    return;
  }
  const s = stage as Record<string, unknown>;
  const mark = DOCKER_FIELDS.find((k) => k in s);
  const docker = mark !== undefined;

  for (const k of Object.keys(s)) {
    if (COMMON_FIELDS.includes(k)) continue;
    if ((docker ? DOCKER_FIELDS : PROCESS_FIELDS).includes(k)) continue;
    if (docker && PROCESS_FIELDS.includes(k)) {
      bad(`"${k}" does not apply to a docker stage`);
    } else {
      bad(`unknown field "${k}"`);
    }
  }

  if (s.pre !== undefined && !isStepish(s.pre)) {
    bad('pre must be a Step function or an array of Step functions');
  }
  if (s.post !== undefined && !isStepish(s.post)) {
    bad('post must be a Step function or an array of Step functions');
  }
  if (s.killSignal !== undefined && typeof s.killSignal !== 'string') {
    bad('killSignal must be a string');
  }

  if (docker) {
    if (s.containerName === undefined) {
      bad(`"${mark}" makes this a docker stage, but containerName is missing`);
    } else if (typeof s.containerName !== 'string' || s.containerName === '') {
      bad('containerName must be a non-empty string');
    }
    if (s.image === undefined) {
      bad(`"${mark}" makes this a docker stage, but image is missing`);
    } else if (typeof s.image !== 'string' || s.image === '') {
      bad('image must be a non-empty string');
    }
    if (s.dockerArgs !== undefined && !isStringArray(s.dockerArgs)) {
      bad('dockerArgs must be an array of strings');
    }
    if (s.cmd !== undefined && !isStringArray(s.cmd)) {
      bad('cmd on a docker stage must be an array of strings');
    }
    return;
  }

  const cmdOk =
    typeof s.cmd === 'string' ? s.cmd.trim() !== '' : isStringArray(s.cmd) && s.cmd.length > 0;
  if (!cmdOk) {
    bad('cmd must be a non-empty string or a non-empty array of strings');
  }
  if (s.cwd !== undefined && typeof s.cwd !== 'string') {
    bad('cwd must be a string');
  }
  if (
    s.env !== undefined &&
    (typeof s.env !== 'object' ||
      s.env === null ||
      Object.values(s.env).some((v) => typeof v !== 'string'))
  ) {
    bad('env must be an object with string values');
  }
}

function validateConfig(cfg: Config): string[] {
  const errors: string[] = [];
  const names = Object.keys(cfg.stages);
  if (names.length === 0) {
    errors.push('config.stages is empty');
  }
  if (names.length > 9) {
    errors.push('at most 9 stages are supported (stage keys are 1-9)');
  }
  for (const name of names) {
    if (/^\d+$/.test(name)) {
      errors.push(
        `stage name "${name}" is all digits; JS enumerates such keys ` +
          'numerically-first, breaking the boot order',
      );
    }
    if (name === 'console' || name === 'dead') {
      errors.push(`stage name "${name}" is reserved`);
    }
    // stage names name log files in tempDir
    if (/[/\\\0]/.test(name) || name.startsWith('.')) {
      errors.push(`stage name "${name}" is not a safe file name`);
    }
    validateStage(name, cfg.stages[name], errors);
  }
  for (const key of Object.keys(cfg.commands ?? {})) {
    if ([...key].length !== 1) {
      errors.push(`command hotkey "${key}" must be a single character`);
    } else if ('0123456789`~!@#$%^&*()'.includes(key)) {
      errors.push(`command hotkey "${key}" is shadowed by the stage/stream keys`);
    }
  }
  return errors;
}

function toSteps(steps: Step | Step[] | undefined): Step[] {
  if (steps === undefined) return [];
  return Array.isArray(steps) ? steps : [steps];
}

function newStageState(name: string, cfg: ProcessStage | DockerStage): StageState {
  return {
    name,
    cfg,
    preSteps: toSteps(cfg.pre),
    postSteps: toSteps(cfg.post),
    preDone: 0,
    postDone: 0,
    postStarted: false,
    up: false,
    crashed: false,
    containerId: '',
    containerStarted: false,
    wantDown: false,
    killSent: false,
    rmStarted: false,
    rmPending: false,
    proc: null,
  };
}

// resolve a --target-stage value to a stage index; exits on nonsense
function resolveTargetStage(value: string): number {
  if (value === 'dead') return 0;
  const byName = status.stages.findIndex((st) => st.name === value);
  if (byName >= 0) return byName + 1;
  if (/^\d+$/.test(value)) {
    const idx = Number(value);
    if (idx <= status.stages.length) return idx;
  }
  process.stderr.write(
    `bad --target-stage "${value}"; expected 'dead', a stage name ` +
      `(${status.stages.map((s) => s.name).join(', ')}), or an index\n`,
  );
  process.exit(1);
}

export type MainOptions = {
  // CI mode (see opts.oneshot); implied when stdin or stdout is not a tty
  oneshot?: boolean;
  // initial target, by name, index, or "dead" (default: the last stage)
  targetStage?: string;
};

// Run devstack.  User code calls this with their config.
export function main(userConfig: Config, options?: MainOptions): void {
  // use queueMicrotask to delay execution until the singletons are configured
  queueMicrotask(() => {
    config = userConfig;
    installProcessHandlers();

    let targetStage: string | undefined;
    if (options === undefined) {
      targetStage = parseArgs(process.argv.slice(2)).targetStage;
    } else {
      opts.oneshot = options.oneshot ?? false;
      targetStage = options.targetStage;
    }

    const errors = validateConfig(config);
    if (errors.length > 0) {
      for (const err of errors) process.stderr.write(`config error: ${err}\n`);
      process.exit(1);
    }

    initStateDir();
    acquireLock();
    recoverOrphans();

    for (const [name, stageCfg] of Object.entries(config.stages)) {
      status.stages.push(newStageState(name, stageCfg));
    }

    target.targetIdx =
      targetStage !== undefined ? resolveTargetStage(targetStage) : status.stages.length;

    // the TUI needs a terminal on both ends; otherwise run headless
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      opts.oneshot = true;
    }

    if (!opts.oneshot) initTerminal();
    if (config.startupInput) feedInput(config.startupInput);
    schedule();
  });
}
