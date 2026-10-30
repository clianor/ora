import { useAui } from '@assistant-ui/react';
import { getUndoableRewind } from '@ora/protocol';
import type { OraEvent, RewindPreview } from '@ora/protocol';
import { FilePen, FileMinus, Info, TriangleAlert, Undo2, X } from 'lucide-react';
import { createContext, useContext, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useStore } from '../store.tsx';
import { Button, KeyHint } from '../ui/button.tsx';

const runningReason = '세션을 멈춘 뒤 쓸 수 있습니다';

interface RewindContextValue {
  isRunning: boolean;
  /** 지금 수정 중인 사용자 메시지의 이벤트 번호입니다. */
  editingSeq: number | null;
  edit: EditState | null;
  startEdit: (seq: number, text: string) => void;
  changeEdit: (next: EditState) => void;
  sendEdit: () => void;
  cancelEdit: () => void;
  askRewind: (seq: number) => void;
}

const RewindContext = createContext<RewindContextValue | null>(null);

/** 사용자 메시지가 되돌리기·수정하기 단추와 수정 상태를 읽는 통로입니다. 세션 화면 밖에서는 null입니다. */
export function useRewind(): RewindContextValue | null {
  return useContext(RewindContext);
}

interface EditState {
  seq: number;
  draft: string;
  preview?: RewindPreview;
  error?: string;
  isSending: boolean;
}

interface DialogState {
  seq: number;
  preview?: RewindPreview;
  error?: string;
  isBusy: boolean;
}

const getMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const timeFormat = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 되돌리기와 수정하기의 화면 상태를 갖고 확인 창을 그립니다. 입력창을 감싼 `ChatProvider` 안에서 씁니다. */
export function RewindProvider({
  sessionId,
  isRunning,
  children,
}: {
  sessionId: string;
  isRunning: boolean;
  children: ReactNode;
}) {
  const { actions } = useStore();
  const aui = useAui();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const value: RewindContextValue = {
    isRunning,
    editingSeq: edit?.seq ?? null,
    edit,
    changeEdit: setEdit,
    sendEdit: () => {
      if (!edit) return;
      setEdit({ ...edit, isSending: true });
      actions
        .editMessage(sessionId, edit.seq, edit.draft.trim())
        .then(() => {
          setEdit(null);
        })
        .catch((error: unknown) => {
          setEdit({ ...edit, isSending: false, error: getMessage(error) });
        });
    },
    cancelEdit: () => {
      setEdit(null);
    },
    startEdit: (seq, text) => {
      setEdit({ seq, draft: text, isSending: false });
      actions
        .previewRewind(sessionId, seq)
        .then((preview) => {
          setEdit((current) => (current?.seq === seq ? { ...current, preview } : current));
        })
        .catch((error: unknown) => {
          setEdit((current) =>
            current?.seq === seq ? { ...current, error: getMessage(error) } : current,
          );
        });
    },
    askRewind: (seq) => {
      setDialog({ seq, isBusy: false });
      actions
        .previewRewind(sessionId, seq)
        .then((preview) => {
          setDialog((current) => (current?.seq === seq ? { ...current, preview } : current));
        })
        .catch((error: unknown) => {
          setDialog((current) =>
            current?.seq === seq ? { ...current, error: getMessage(error) } : current,
          );
        });
    },
  };

  return (
    <RewindContext value={value}>
      {children}
      {dialog && (
        <RewindDialog
          dialog={dialog}
          onCancel={() => {
            setDialog(null);
          }}
          onConfirm={() => {
            setDialog({ ...dialog, isBusy: true });
            actions
              .rewindSession(sessionId, dialog.seq)
              .then((result) => {
                aui.composer.setText(result.text);
                setDialog(null);
              })
              .catch((error: unknown) => {
                setDialog({ ...dialog, isBusy: false, error: getMessage(error) });
              });
          }}
        />
      )}
    </RewindContext>
  );
}

/** 수정 중인 사용자 메시지 자리에 그리는 입력 상자입니다. */
export function EditBox() {
  const rewind = useRewind();
  if (!rewind?.edit) return null;
  const { edit, changeEdit: onChange, sendEdit: onSend, cancelEdit: onCancel } = rewind;
  const preview = edit.preview;
  const canSend =
    edit.draft.trim() !== '' && !edit.isSending && preview?.blockedReason === undefined;
  let note = '불러오는 중입니다';
  if (edit.error) note = edit.error;
  else if (preview?.blockedReason) note = preview.blockedReason;
  else if (preview) {
    note = preview.isGitRepo
      ? `보내면 이 메시지 전으로 되돌린 뒤 다시 시작합니다 · 파일 ${preview.restoreFiles.length}개를 되돌리고 ${preview.deleteFiles.length}개를 지웁니다`
      : '보내면 이 메시지 전으로 되돌린 뒤 다시 시작합니다 · 이 폴더는 git 저장소가 아니라 대화만 되돌립니다';
  }
  return (
    <div className="flex w-full flex-col gap-2.5 rounded-lg border border-border-strong bg-surface-raised px-3.5 py-3">
      <textarea
        autoFocus
        aria-label="메시지 수정"
        rows={Math.min(8, Math.max(2, edit.draft.split('\n').length))}
        value={edit.draft}
        onChange={(event) => {
          onChange({ ...edit, draft: event.target.value });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend) onSend();
          }
        }}
        className="w-full resize-none bg-transparent text-sm leading-[22px] text-foreground outline-none"
      />
      <div className="flex items-center gap-2">
        <Info aria-hidden className="size-[13px] shrink-0 text-foreground-subtle" />
        <p
          role={edit.error ? 'alert' : undefined}
          className="flex-1 text-xs leading-4 text-foreground-subtle"
        >
          {note}
        </p>
        <Button variant="ghost" onClick={onCancel}>
          취소
        </Button>
        <Button variant="primary" disabled={!canSend} onClick={onSend}>
          보내기
          <KeyHint>↵</KeyHint>
        </Button>
      </div>
    </div>
  );
}

function FileRow({ icon, path, note }: { icon: ReactNode; path: string; note: string }) {
  return (
    <li className="flex h-6 items-center gap-2 px-1 text-xs leading-4">
      {icon}
      <span className="font-mono font-medium text-foreground">{path}</span>
      <span className="text-foreground-subtle">{note}</span>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="px-1 pb-0.5 text-xs leading-4 font-semibold text-foreground-muted">{title}</h3>
      <ul>{children}</ul>
    </section>
  );
}

function RewindDialog({
  dialog,
  onCancel,
  onConfirm,
}: {
  dialog: DialogState;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const { preview } = dialog;
  const canConfirm = preview !== undefined && preview.blockedReason === undefined && !dialog.isBusy;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (canConfirm) onConfirm();
        }}
        className="flex max-h-[calc(100%-32px)] w-[560px] max-w-[calc(100%-32px)] flex-col gap-3.5 overflow-y-auto rounded-xl border border-border-strong bg-popover p-5"
      >
        <div className="flex items-center gap-2">
          <Undo2 aria-hidden className="size-[18px] text-foreground" />
          <h2 id={titleId} className="text-[17px] leading-6 font-semibold text-foreground">
            이 메시지 전으로 되돌리기
          </h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onCancel}
            className="ml-auto flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:text-foreground"
          >
            <X aria-hidden className="size-[15px]" />
          </button>
        </div>
        {dialog.error && (
          <p role="alert" className="text-xs leading-[18px] text-danger">
            {dialog.error}
          </p>
        )}
        {preview === undefined ? (
          dialog.error === undefined && (
            <p className="text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
          )
        ) : (
          <PreviewBody preview={preview} />
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            취소
          </Button>
          <Button variant="primary" type="submit" autoFocus disabled={!canConfirm}>
            되돌리기
            <KeyHint>↵</KeyHint>
          </Button>
        </div>
      </form>
    </div>
  );
}

function PreviewBody({ preview }: { preview: RewindPreview }) {
  const overwrittenPaths = new Set(preview.overwrittenFiles.map((file) => file.path));
  const hasWarnings =
    preview.overwrittenFiles.length > 0 ||
    preview.otherSessionFiles.length > 0 ||
    preview.skippedFiles.length > 0;
  return (
    <>
      <p className="rounded-md bg-surface-sunken px-3 py-2 text-[13px] leading-5 whitespace-pre-line text-foreground-muted">
        {preview.text}
      </p>
      {preview.blockedReason && (
        <p role="alert" className="text-xs leading-[18px] text-danger">
          {preview.blockedReason}
        </p>
      )}
      {!preview.isGitRepo && (
        <p className="text-xs leading-[18px] text-foreground-muted">
          이 폴더는 git 저장소가 아니라 파일은 되돌리지 않습니다
        </p>
      )}
      {preview.restoreFiles.length > 0 && (
        <Section title={`되돌릴 파일 ${preview.restoreFiles.length}개`}>
          {preview.restoreFiles.map((path) => (
            <FileRow
              key={path}
              icon={<FilePen aria-hidden className="size-[13px] text-foreground-muted" />}
              path={path}
              note={
                overwrittenPaths.has(path)
                  ? '이 메시지를 보내기 전 내용으로 (직접 고친 내용을 덮어씁니다)'
                  : '이 메시지를 보내기 전 내용으로'
              }
            />
          ))}
        </Section>
      )}
      {preview.deleteFiles.length > 0 && (
        <Section title={`지울 파일 ${preview.deleteFiles.length}개`}>
          {preview.deleteFiles.map((path) => (
            <FileRow
              key={path}
              icon={<FileMinus aria-hidden className="size-[13px] text-danger" />}
              path={path}
              note="이 세션이 그 뒤에 새로 만든 파일"
            />
          ))}
        </Section>
      )}
      {hasWarnings && (
        <div className="flex flex-col gap-1 rounded-md bg-surface-raised px-3 py-2.5">
          {preview.overwrittenFiles.length > 0 && (
            <>
              <p className="flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-foreground">
                <TriangleAlert aria-hidden className="size-3.5 text-warning" />
                직접 고친 내용을 덮어쓰는 파일 {preview.overwrittenFiles.length}개
              </p>
              <ul>
                {preview.overwrittenFiles.map((file) => (
                  <FileRow
                    key={file.path}
                    icon={<FilePen aria-hidden className="size-[13px] text-warning" />}
                    path={file.path}
                    note={`세션이 마지막으로 저장한 뒤 ${timeFormat.format(new Date(file.modifiedAt))}에 누군가 고쳤습니다`}
                  />
                ))}
              </ul>
            </>
          )}
          {preview.otherSessionFiles.length > 0 && (
            <>
              <p className="flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-foreground">
                <TriangleAlert aria-hidden className="size-3.5 text-warning" />
                다른 세션이 그 뒤에 바꾼 파일 {preview.otherSessionFiles.length}개
              </p>
              <ul>
                {preview.otherSessionFiles.map((file) => (
                  <FileRow
                    key={`${file.sessionId}:${file.path}`}
                    icon={<FilePen aria-hidden className="size-[13px] text-warning" />}
                    path={file.path}
                    note={`세션 “${file.title}”이 바꿨습니다`}
                  />
                ))}
              </ul>
            </>
          )}
          {preview.skippedFiles.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs leading-[18px] text-foreground-muted">
              <TriangleAlert aria-hidden className="size-3.5 text-warning" />
              너무 커서 되돌리지 못하는 파일 {preview.skippedFiles.length}개:{' '}
              {preview.skippedFiles.join(', ')}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1 text-xs leading-[18px] text-foreground-subtle">
        <p>
          대화에서 메시지 {preview.removedMessages}개가 빠집니다.
          {preview.commitCount > 0 &&
            ` 이후에 만든 커밋 ${preview.commitCount}개는 브랜치에 그대로 남습니다.`}
        </p>
        <p>
          이 세션이 바꾸지 않은 파일은 그대로 둡니다. 되돌린 뒤에도 다음 메시지를 보내기 전까지는
          취소할 수 있습니다.
        </p>
      </div>
    </>
  );
}

/** 입력창 아래 줄 오른쪽의 "마지막 요청 되돌리기"입니다. 세션이 실행 중이면 끄고 이유를 보입니다. */
export function LastRewindButton({ lastSeq }: { lastSeq: number | null }) {
  const rewind = useRewind();
  if (rewind === null || lastSeq === null) return null;
  return (
    <button
      type="button"
      disabled={rewind.isRunning}
      title={rewind.isRunning ? runningReason : undefined}
      onClick={() => {
        rewind.askRewind(lastSeq);
      }}
      className="ml-auto flex items-center gap-1 text-xs leading-4 text-foreground-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <Undo2 aria-hidden className="size-3" />
      {rewind.isRunning ? `마지막 요청 되돌리기 · ${runningReason}` : '마지막 요청 되돌리기'}
    </button>
  );
}

/** 되돌린 직후부터 다음 메시지를 보내기 전까지 입력창 위에 보이는 알림입니다. */
export function UndoNotice({ sessionId, events }: { sessionId: string; events: OraEvent[] }) {
  const { actions } = useStore();
  const aui = useAui();
  const rewind = getUndoableRewind(events);
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (rewind === undefined || dismissedSeq === rewind.seq) return null;
  const { restoredFiles, deletedFiles, isGitRepo, text } = rewind.payload;
  return (
    <div
      role="status"
      className="mb-2 flex w-[420px] max-w-[calc(100%-var(--s-6)*2)] items-center gap-2.5 rounded-xl border border-border-strong bg-popover px-3.5 py-3"
    >
      <Undo2 aria-hidden className="size-4 shrink-0 text-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[13px] leading-[18px] font-semibold text-foreground">되돌렸습니다</p>
        <p className="text-xs leading-4 text-foreground-subtle">
          {error ??
            (isGitRepo
              ? `파일 ${restoredFiles.length}개를 되돌리고 ${deletedFiles.length}개를 지웠습니다`
              : '대화만 되돌렸습니다')}
        </p>
      </div>
      <Button
        onClick={() => {
          setError(null);
          actions
            .undoRewind(sessionId)
            .then(() => {
              if (aui.composer.getState().text === text) aui.composer.setText('');
              setDismissedSeq(rewind.seq);
            })
            .catch((failure: unknown) => {
              setError(getMessage(failure));
            });
        }}
      >
        되돌리기 취소
      </Button>
    </div>
  );
}

export { runningReason };
