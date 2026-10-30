import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { app, BrowserWindow, ipcMain, net, Notification, protocol } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { createHost, describeRouteError } from '@ora/host';
import type { EventStream, Host } from '@ora/host';

const APP_ORIGIN = 'app://ora';
const STREAM_BATCH = 2000;
const SETTLE_MS = 2000;
const TARGETS = { windowMs: 2000, bigSessionMs: 1000, diffMs: 200, soakGrowthMb: 500 };
const BIG_SESSION_ID = 's-20261030-perfbg';
const DIFF_SESSION_ID = 's-20261030-perfdf';

const { values: flags } = parseArgs({
  args: process.argv.slice(1),
  strict: false,
  allowPositionals: true,
  options: {
    cwd: { type: 'string' },
    config: { type: 'string' },
    'model-script': { type: 'string' },
    isolation: { type: 'string' },
    'perf-report': { type: 'string' },
    'perf-soak': { type: 'string' },
    'smoke-report': { type: 'string' },
    'smoke-shots': { type: 'string' },
    'smoke-hold-sec': { type: 'string' },
  },
});
const flag = (name: string): string | undefined => {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const webRoot = app.isPackaged
  ? join(process.resourcesPath, 'web')
  : resolve(import.meta.dirname, '../../web/dist');

/** 로컬 HTTP 서버 없이 웹 결과물을 `app://ora/`로 제공한다. */
function serveWebFile(request: Request): Promise<Response> | Response {
  let file = resolve(webRoot, `.${decodeURIComponent(new URL(request.url).pathname)}`);
  if (file !== webRoot && !file.startsWith(webRoot + sep)) return new Response('', { status: 404 });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, 'index.html');
  return net.fetch(pathToFileURL(file).toString());
}

/** 이벤트 흐름을 연 뒤 마지막 묶음을 렌더러로 보낼 때까지 걸린 시간이다. 성능 보고가 IPC 전달 시간을 따로 적는다. */
const streamDeliveryMs = new Map<string, number>();

function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`) ?? false;
}

interface StreamMessage {
  kind: 'open' | 'items' | 'end' | 'error';
  items?: { name?: string; data: unknown }[];
  status?: number;
  message?: string;
}

const notificationClickStreams = new Set<(data: unknown) => void>();

function startMain(host: Host) {
  const streams = new Map<WebContents, Map<number, () => void>>();

  const post = (contents: WebContents, id: number, message: StreamMessage) => {
    if (!contents.isDestroyed()) contents.send('ora:stream', id, message);
  };

  ipcMain.handle('ora:request', async (event, raw: unknown) => {
    if (!isTrustedSender(event))
      return { status: 403, body: { error: '허용하지 않는 요청입니다.' } };
    const { method, path, body } = raw as { method: string; path: string; body?: unknown };
    if (method === 'POST' && path === '/desktop/notify') {
      const {
        title,
        body: text,
        sessionId,
        kind,
      } = body as {
        title: string;
        body: string;
        sessionId?: string;
        kind?: string;
      };
      const notification = new Notification({ title, body: text });
      notification.on('click', () => {
        BrowserWindow.getAllWindows()[0]?.show();
        for (const send of notificationClickStreams) send({ sessionId, kind });
      });
      notification.show();
      return { status: 200, body: { ok: true } };
    }
    let status = 0;
    let result: unknown;
    try {
      await host.route(
        {
          method,
          url: new URL(path, APP_ORIGIN),
          lastEventId: undefined,
          readJson: () => Promise.resolve(body),
        },
        {
          json: (code, value) => {
            status = code;
            result = value;
          },
          openStream: () => {
            throw new Error('스트림은 subscribe로 엽니다.');
          },
        },
      );
    } catch (error) {
      const failure = describeRouteError(error);
      return { status: failure.status, body: { error: failure.message } };
    }
    return { status, body: result };
  });

  ipcMain.on('ora:subscribe', (event, id: number, path: string) => {
    if (!isTrustedSender(event)) return;
    const contents = event.sender;
    const open = streams.get(contents) ?? new Map<number, () => void>();
    streams.set(contents, open);
    let queue: { name?: string; data: unknown }[] = [];
    let isClosed = false;
    let isScheduled = false;
    const closeListeners: (() => void)[] = [];
    const close = () => {
      if (isClosed) return;
      isClosed = true;
      open.delete(id);
      for (const listener of closeListeners) listener();
    };
    open.set(id, close);
    const startedAt = performance.now();
    const flush = () => {
      isScheduled = false;
      while (queue.length > 0 && !isClosed) {
        post(contents, id, { kind: 'items', items: queue.slice(0, STREAM_BATCH) });
        queue = queue.slice(STREAM_BATCH);
      }
      streamDeliveryMs.set(path, performance.now() - startedAt);
    };
    const enqueue = (name: string | undefined, data: unknown) => {
      queue.push(name === undefined ? { data } : { name, data });
      if (!isScheduled) {
        isScheduled = true;
        setImmediate(flush);
      }
    };
    if (path === '/desktop/notification-click') {
      const send = (data: unknown) => {
        enqueue(undefined, data);
      };
      notificationClickStreams.add(send);
      closeListeners.push(() => notificationClickStreams.delete(send));
      post(contents, id, { kind: 'open' });
      return;
    }
    const stream: EventStream = {
      send: (name, data) => {
        enqueue(name, data);
      },
      end: () => {
        flush();
        post(contents, id, { kind: 'end' });
        close();
      },
      isClosed: () => isClosed,
      onClose: (listener) => closeListeners.push(listener),
    };
    let isOpened = false;
    host
      .route(
        {
          method: 'GET',
          url: new URL(path, APP_ORIGIN),
          lastEventId: undefined,
          readJson: () => Promise.reject(new Error('본문이 없습니다.')),
        },
        {
          json: (status, body) => {
            post(contents, id, { kind: 'error', status, message: JSON.stringify(body) });
            close();
          },
          openStream: () => {
            isOpened = true;
            post(contents, id, { kind: 'open' });
            return stream;
          },
        },
      )
      .then(() => {
        if (!isOpened && !isClosed) {
          post(contents, id, { kind: 'error', status: 404, message: '알 수 없는 API입니다.' });
          close();
        }
      })
      .catch((error: unknown) => {
        const failure = describeRouteError(error);
        post(contents, id, { kind: 'error', status: failure.status, message: failure.message });
        close();
      });
  });

  ipcMain.on('ora:unsubscribe', (event, id: number) => {
    streams.get(event.sender)?.get(id)?.();
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#161a22',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  win.loadURL(`${APP_ORIGIN}/`).catch((error: unknown) => {
    process.stderr.write(`창을 불러오지 못했습니다: ${String(error)}\n`);
  });
  return win;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** 페이지 안에서 `text`가 나타나고 두 프레임이 그려질 때까지 걸린 시간(ms)을 잰다. */
function measureTextShown(win: BrowserWindow, text: string, timeoutMs: number): Promise<number> {
  const script = `new Promise((done, fail) => {
    const doc = globalThis.document;
    const start = performance.now();
    const poll = () => {
      if (doc.body.textContent.includes(${JSON.stringify(text)})) {
        requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - start)));
      } else if (performance.now() - start > ${timeoutMs}) {
        fail(new Error('시간 초과: ' + ${JSON.stringify(text)}));
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  })`;
  return win.webContents.executeJavaScript(script) as Promise<number>;
}

async function showSession(win: BrowserWindow, sessionId: string, marker: string): Promise<number> {
  await win.webContents.executeJavaScript(
    `globalThis.location.hash = ${JSON.stringify(`#/session/${sessionId}`)}`,
  );
  return measureTextShown(win, marker, 120_000);
}

function sampleRendererMemory(): number {
  const renderer = app.getAppMetrics().find((metric) => metric.type === 'Tab');
  return (renderer?.memory.workingSetSize ?? 0) / 1024;
}

function waitForReadyToShow(win: BrowserWindow): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  win.once('ready-to-show', () => {
    resolve(undefined);
  });
  return promise;
}

async function runPerf(win: BrowserWindow, reportPath: string, soakMinutes: number) {
  await waitForReadyToShow(win);
  await win.webContents.executeJavaScript(
    'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))',
  );
  const startToWindowMs = round(process.uptime() * 1000);
  await measureTextShown(win, '워크트리', 60_000);
  // 창을 띄운 직후에는 시작 요청(git, 스킬 조회)이 몰려 있으므로, 그 요청이 끝난 뒤 세션 화면 시간을 잰다.
  await new Promise((done) => setTimeout(done, SETTLE_MS));
  const diffRenderMs = round(await showSession(win, DIFF_SESSION_ID, 'const after4999 = 4999;'));
  // 기본 화면이 가장 새 세션을 미리 읽으므로, 페이지를 새로 불러 그 세션을 처음 여는 시간을 잰다.
  const bigStartedAt = performance.now();
  await win.webContents.executeJavaScript(
    `globalThis.location.hash = ${JSON.stringify(`#/session/${BIG_SESSION_ID}`)}`,
  );
  await reloadPage(win);
  await measureTextShown(win, '파일 24999을 읽었습니다', 120_000);
  const bigSessionFirstScreenMs = round(performance.now() - bigStartedAt);
  const bigSessionDeliveryMs = round(
    streamDeliveryMs.get(`/api/sessions/${BIG_SESSION_ID}/events`) ?? -1,
  );
  const samples: { atSec: number; rendererMb: number }[] = [];
  const intervalSec = 10;
  const rounds = Math.floor((soakMinutes * 60) / intervalSec);
  for (let index = 0; index <= rounds; index += 1) {
    samples.push({ atSec: index * intervalSec, rendererMb: round(sampleRendererMemory()) });
    if (index < rounds) await new Promise((done) => setTimeout(done, intervalSec * 1000));
  }
  const growthMb = round((samples.at(-1)?.rendererMb ?? 0) - (samples[0]?.rendererMb ?? 0));
  const report = {
    electron: process.versions.electron,
    platform: `${process.platform}-${process.arch}`,
    isPackaged: app.isPackaged,
    targets: TARGETS,
    startToWindowMs,
    bigSessionFirstScreenMs,
    bigSessionDeliveryMs,
    diffRenderMs,
    soak: { minutes: soakMinutes, intervalSec, growthMb, samples },
    passed: {
      window: startToWindowMs <= TARGETS.windowMs,
      bigSession: bigSessionFirstScreenMs <= TARGETS.bigSessionMs,
      diff: diffRenderMs <= TARGETS.diffMs,
      soak: growthMb <= TARGETS.soakGrowthMb,
    },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function savePng(win: BrowserWindow, file: string | undefined) {
  if (file === undefined) return;
  writeFileSync(file, (await win.webContents.capturePage()).toPNG());
}

async function reloadPage(win: BrowserWindow) {
  const { promise: loaded, resolve } = Promise.withResolvers<undefined>();
  win.webContents.once('did-finish-load', () => {
    resolve(undefined);
  });
  win.webContents.reload();
  await loaded;
}

/** 패키징한 앱이 창, 세션, 터미널을 IPC만으로 처리하는지 확인하고 결과를 JSON으로 적는다. */
async function runSmoke(win: BrowserWindow, reportPath: string, cwd: string) {
  await waitForReadyToShow(win);
  await measureTextShown(win, '워크트리', 60_000);
  const shotsDir = flag('smoke-shots');
  const shot = (name: string) => (shotsDir === undefined ? undefined : join(shotsDir, name));
  await savePng(win, shot('1-window.png'));
  const page = (body: string) =>
    win.webContents
      .executeJavaScript(`(async () => { const ora = globalThis.ora; const cwd = ${JSON.stringify(cwd)};
      const call = async (method, path, body) => {
        const reply = await ora.request(method, path, body);
        if (reply.status >= 300) throw new Error(method + ' ' + path + ' ' + reply.status + ' ' + JSON.stringify(reply.body));
        return reply.body;
      };
      ${body} })()`) as Promise<Record<string, unknown>>;

  const session = await page(`
    const { sessionId } = await call('POST', '/api/sessions', { task: '스모크 확인', cwd });
    let status = 'pending';
    for (let i = 0; i < 1200 && ['pending', 'created', 'running'].includes(status); i += 1) {
      await new Promise((done) => setTimeout(done, 100));
      try {
        status = (await call('GET', '/api/sessions/' + sessionId)).session.status;
      } catch {
        // 워커가 기록을 쓰기 전에는 세션 기록이 없다.
      }
    }
    const { session } = await call('GET', '/api/sessions/' + sessionId);
    const repo = session.repo;
    await call('PUT', '/api/tabs', { cwd, tabs: { tabs: [{ id: 'ss1', kind: 'session', sessionId }], activeTabId: 'ss1' } });
    globalThis.location.hash = '#/worktree?cwd=' + encodeURIComponent(repo) + '&tab=ss1';
    return { sessionId, status, repo };`);
  await reloadPage(win);
  await measureTextShown(win, '스모크 확인을 마칩니다', 30_000);
  await savePng(win, shot('2-session.png'));

  const terminalId = (
    await page(`
    const { terminal } = await call('POST', '/api/terminals', { cwd, cols: 100, rows: 24 });
    const sessionTab = { id: 'ss1', kind: 'session', sessionId: ${JSON.stringify(session.sessionId)} };
    await call('PUT', '/api/tabs', { cwd, tabs: { tabs: [sessionTab, { id: 'tt1', kind: 'terminal', terminalId: terminal.id }], activeTabId: 'tt1' } });
    globalThis.location.hash = '#/worktree?cwd=' + encodeURIComponent(${JSON.stringify(session.repo)}) + '&tab=tt1';
    return { terminalId: terminal.id };`)
  ).terminalId as string;
  await reloadPage(win);
  await measureTextShown(win, '터미널 1', 30_000);
  await new Promise((done) => setTimeout(done, 1500));
  const terminal = await page(`
    let output = '';
    const stop = ora.subscribe('/api/terminals/${terminalId}/output', (message) => {
      if (message.kind !== 'items') return;
      for (const item of message.items) if (item.name === 'output') output += atob(item.data.data);
    });
    await new Promise((done) => setTimeout(done, 1000));
    await call('POST', '/api/terminals/${terminalId}/input', { data: 'echo ORA_TERM_$((6*7))\\r' });
    for (let i = 0; i < 100 && !output.includes('ORA_TERM_42\\r\\n'); i += 1) {
      await new Promise((done) => setTimeout(done, 100));
    }
    stop();
    return { terminalId: '${terminalId}', sawOutput: output.includes('ORA_TERM_42\\r\\n') };`);
  await new Promise((done) => setTimeout(done, 500));
  await savePng(win, shot('3-terminal.png'));

  const dragRegions = (await win.webContents.executeJavaScript(`(() => {
    const doc = globalThis.document;
    const region = (element) => (element ? getComputedStyle(element).getPropertyValue('-webkit-app-region') : null);
    const header = doc.querySelector('main [data-titlebar], header[data-titlebar]');
    return { titleBar: region(header), titleBarButton: region(header?.querySelector('button')), sidebarTopRow: region(doc.querySelector('aside [data-titlebar]')) };
  })()`)) as Record<string, string | null>;
  const pids = [process.pid, ...app.getAppMetrics().map((metric) => metric.pid)];
  writeFileSync(
    reportPath,
    `${JSON.stringify({ isPackaged: app.isPackaged, session, terminal, dragRegions, pids: [...new Set(pids)] }, null, 2)}\n`,
  );
}

/** 최상위 await로 `ready`를 기다리면 ESM 메인 프로세스가 멈추므로 콜백으로 시작한다. */
async function start() {
  protocol.handle('app', serveWebFile);
  process.env.ORA_PROMPTS_DIR = app.isPackaged
    ? join(process.resourcesPath, 'prompts')
    : resolve(import.meta.dirname, '../../../prompts');
  const cwd = flag('cwd') ?? (process.cwd() === '/' ? app.getPath('home') : process.cwd());
  const isolation = flag('isolation');
  const configPath = flag('config');
  const modelScriptPath = flag('model-script');
  const host = await createHost({
    env: process.env,
    cwd,
    workerPath: join(import.meta.dirname, 'worker.js'),
    ...(configPath === undefined ? {} : { configPath }),
    ...(modelScriptPath === undefined ? {} : { modelScriptPath }),
    ...(isolation === 'none' || isolation === 'harness' || isolation === 'clean-home'
      ? { isolation }
      : {}),
  });
  startMain(host);
  const win = createWindow();

  let isClosing = false;
  app.on('before-quit', (event) => {
    if (isClosing) return;
    isClosing = true;
    event.preventDefault();
    const quit = () => {
      app.quit();
    };
    host.close().then(quit, quit);
  });

  const smokeReport = flag('smoke-report');
  if (smokeReport !== undefined) {
    await runSmoke(win, smokeReport, cwd).catch(async (error: unknown) => {
      const shotsDir = flag('smoke-shots');
      await savePng(win, shotsDir === undefined ? undefined : join(shotsDir, 'error.png'));
      const pageText = (await win.webContents.executeJavaScript(
        'globalThis.document.body.innerText.slice(0, 600)',
      )) as string;
      writeFileSync(
        smokeReport,
        `${JSON.stringify({ error: String(error), pageText }, null, 2)}\n`,
      );
      process.exitCode = 1;
    });
    await new Promise((done) => setTimeout(done, Number(flag('smoke-hold-sec') ?? 0) * 1000));
    app.quit();
    return;
  }
  const perfReport = flag('perf-report');
  if (perfReport === undefined) return;
  await runPerf(win, perfReport, Number(flag('perf-soak') ?? 0)).catch((error: unknown) => {
    writeFileSync(perfReport, `${JSON.stringify({ error: String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  });
  app.quit();
}

app.on('window-all-closed', () => {
  app.quit();
});
app
  .whenReady()
  .then(start)
  .catch((error: unknown) => {
    process.stderr.write(`시작하지 못했습니다: ${String(error)}\n`);
    app.exit(1);
  });
