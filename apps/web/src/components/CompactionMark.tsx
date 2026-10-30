import type { DataMessagePartProps } from '@assistant-ui/react';
import { ChevronDown, ChevronUp, FoldVertical } from 'lucide-react';
import { useId, useState } from 'react';
import type { CompactionMarkData } from '../events.ts';
import { formatRange, parseSummaryDocument, type SummarySection } from '../lib/context.ts';
import { runAction, useActions } from '../store.tsx';
import { Button } from '../ui/button.tsx';

const timeFormat = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Seoul',
});

function getLabel(mark: CompactionMarkData): string {
  switch (mark.method) {
    case 'prune':
      return `도구 출력 ${mark.count}개를 생략했습니다`;
    case 'shake':
      return `큰 출력 ${mark.count}개를 참조로 바꿨습니다`;
    case 'handoff':
      return `${formatRange(mark.range)}${mark.range ? '를' : '을'} 인계 문서로 바꿨습니다`;
    case 'summary':
      if (mark.prepared === 'ahead')
        return `${formatRange(mark.range)}${mark.range ? '를' : '을'} 기준선에 닿기 전에 미리 요약해 두었습니다`;
      if (mark.prepared === 'idle')
        return `${formatRange(mark.range)}${mark.range ? '를' : '을'} 캐시가 끝나기 전에 미리 요약했습니다`;
      return `${formatRange(mark.range)}${mark.range ? '를' : '을'} 요약했습니다`;
    case 'remote':
      return `${formatRange(mark.range)}${mark.range ? '를' : '을'} 서버가 쓴 요약으로 바꿨습니다`;
  }
}

/** 엔진이 기록에서 만든 절을 먼저, 모델이 쓴 절을 뒤에 둡니다. 시안의 순서입니다. */
const sectionOrder = ['할 일', '사용자 지시', '남은 오류'];

function sortSections(sections: readonly SummarySection[]): SummarySection[] {
  const rank = (title: string) => {
    const index = sectionOrder.indexOf(title);
    return index === -1 ? sectionOrder.length : index;
  };
  return sections.toSorted((a, b) => rank(a.title) - rank(b.title));
}

function SummaryBody({ sections }: { sections: readonly SummarySection[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-3.5">
      {sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-1">
          <h3 className="text-xs leading-4 font-semibold text-foreground">{section.title}</h3>
          {(section.lines.length === 0 ? [[{ text: '없음', isCode: false }]] : section.lines).map(
            (line, index) => (
              <p key={index} className="text-xs leading-[18px] text-foreground-muted">
                {line.map((span, spanIndex) =>
                  span.isCode ? (
                    <span key={spanIndex} className="font-mono text-foreground">
                      {span.text}
                    </span>
                  ) : (
                    span.text
                  ),
                )}
              </p>
            ),
          )}
        </section>
      ))}
    </div>
  );
}

type SummaryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; sections: SummarySection[] };

/** 컨텍스트를 줄인 자리에 놓는 가는 선과 글입니다. 위쪽 대화는 지우지 않고 그대로 둡니다. */
export function CompactionMark({ data }: DataMessagePartProps) {
  const mark = data as CompactionMarkData;
  const actions = useActions();
  const bodyId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [summary, setSummary] = useState<SummaryState>({ status: 'idle' });
  const isSummary =
    mark.method === 'handoff' || mark.method === 'summary' || mark.method === 'remote';
  const canExpand = mark.method === 'prune' ? mark.items.length > 0 : isSummary && !!mark.path;

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    const { path, method } = mark;
    if (!next || !path || summary.status === 'ready') return;
    if (method !== 'handoff' && method !== 'summary' && method !== 'remote') return;
    setSummary({ status: 'loading' });
    runAction(
      actions
        .readCompaction(mark.sessionId, path)
        .then((text) => {
          setSummary({
            status: 'ready',
            sections: sortSections(
              parseSummaryDocument(text, method === 'handoff' ? 'handoff' : 'summary'),
            ),
          });
        })
        .catch((error: unknown) => {
          setSummary({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  };

  const isList = mark.method === 'prune';
  let toggleLabel = isList ? '목록 보기' : '펼치기';
  if (isOpen) toggleLabel = isList ? '목록 접기' : '접기';
  const Chevron = isOpen ? ChevronUp : ChevronDown;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <div className="h-px flex-1 bg-border" />
        <div className="flex items-center gap-1.5 text-xs leading-4">
          <FoldVertical aria-hidden className="size-3.5 text-foreground-subtle" />
          <span className="font-medium text-foreground-muted">{getLabel(mark)}</span>
          <span className="text-foreground-muted">· {timeFormat.format(new Date(mark.ts))}</span>
        </div>
        {canExpand && (
          <Button variant="ghost" aria-expanded={isOpen} aria-controls={bodyId} onClick={toggle}>
            {toggleLabel}
            <Chevron aria-hidden className="size-3.5" />
          </Button>
        )}
        <div className="h-px flex-1 bg-border" />
      </div>
      {isOpen && (
        <div id={bodyId}>
          {mark.method === 'prune' && (
            <ul className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-3.5">
              {mark.items.map((item, index) => (
                <li key={index} className="flex gap-2 text-xs leading-[18px]">
                  <span className="text-foreground-muted">{item.tool}</span>
                  <span className="min-w-0 truncate font-mono text-foreground">{item.target}</span>
                </li>
              ))}
            </ul>
          )}
          {isSummary && summary.status === 'loading' && (
            <p role="status" className="text-xs leading-4 text-foreground-muted">
              요약 파일을 읽는 중입니다
            </p>
          )}
          {isSummary && summary.status === 'error' && (
            <p role="alert" className="text-xs leading-4 text-danger">
              요약 파일을 읽지 못했습니다. {summary.message}
            </p>
          )}
          {isSummary && summary.status === 'ready' && <SummaryBody sections={summary.sections} />}
        </div>
      )}
    </div>
  );
}
