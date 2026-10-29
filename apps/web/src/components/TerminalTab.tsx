import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { runAction, useStore } from '../store.tsx';

/** powerline 기호를 쓰는 셸 테마용 대체 글꼴입니다. 사용자 컴퓨터에 깔린 것만 쓰이고 글꼴 파일은 앱에 싣지 않습니다. */
const nerdFonts =
  '"MesloLGS NF", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "JetBrainsMono Nerd Font Mono", "Hack Nerd Font", "FiraCode Nerd Font", "Symbols Nerd Font Mono", monospace';

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function RestartBar({ message, onRestart }: { message: string; onRestart: () => void }) {
  return (
    <button
      type="button"
      onClick={onRestart}
      className="flex h-9 w-full shrink-0 items-center gap-1.5 bg-surface px-4 text-[13px] leading-[18px] text-foreground-muted hover:text-foreground"
    >
      {message} · 새로 열기
    </button>
  );
}

function TerminalView({ terminalId, onRestart }: { terminalId: string; onRestart: () => void }) {
  const { actions } = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const [exitCode, setExitCode] = useState<number>();

  /** xterm 화면과 서버 출력 스트림은 React 밖의 시스템이라서, 마운트할 때 만들고 언마운트할 때 해제합니다. */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: `${readToken('--font-mono')}, ${nerdFonts}`,
      fontSize: 13,
      theme: {
        background: readToken('--surface-sunken'),
        foreground: readToken('--foreground'),
        cursor: readToken('--foreground'),
        selectionBackground: readToken('--border-strong'),
        red: readToken('--danger'),
        green: readToken('--success'),
        yellow: readToken('--warning'),
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    const stopWatching = actions.watchTerminal(terminalId, {
      onOutput: (bytes) => {
        terminal.write(bytes);
      },
      onExit: setExitCode,
      onReset: () => {
        terminal.reset();
      },
    });
    const input = terminal.onData((data) => {
      runAction(actions.sendTerminalInput(terminalId, data));
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      runAction(actions.resizeTerminal(terminalId, { cols, rows }));
    });
    /** 사이드바를 접거나 창 크기가 바뀌면 터미널 칸 수를 다시 맞춰야 해서 요소 크기를 관찰합니다. */
    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      resize.dispose();
      input.dispose();
      stopWatching();
      terminal.dispose();
    };
  }, [actions, terminalId]);

  return (
    <>
      <div className="min-h-0 flex-1 bg-surface-sunken p-3">
        <div ref={hostRef} className="size-full" />
      </div>
      {exitCode !== undefined && (
        <RestartBar message={`종료됨 (코드 ${String(exitCode)})`} onRestart={onRestart} />
      )}
    </>
  );
}

/** 터미널 탭의 내용입니다. 서버가 다시 떠서 터미널이 사라졌으면 끝났다는 안내를 보입니다. */
export function TerminalTab({
  terminalId,
  onRestart,
}: {
  terminalId: string;
  onRestart: () => void;
}) {
  const terminal = useStore().getTerminal(terminalId);
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {terminal ? (
        <TerminalView terminalId={terminalId} onRestart={onRestart} />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <RestartBar message="터미널이 끝났습니다" onRestart={onRestart} />
        </div>
      )}
    </main>
  );
}
