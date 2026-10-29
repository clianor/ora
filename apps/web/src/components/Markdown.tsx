import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import type { ComponentPropsWithoutRef } from 'react';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/cn.ts';

const remarkPlugins = [remarkGfm];

/** 라이브러리가 넘기는 `node`는 DOM 속성이 아니므로 빼고 나머지만 요소에 넘깁니다. */
function omitNode<T extends object>(props: T): Omit<T, 'node'> {
  return Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'node')) as Omit<
    T,
    'node'
  >;
}

/** 마크다운 요소를 DESIGN.md 규격으로 그립니다. 구문 강조는 아직 없습니다. */
const components = {
  p: (props: ComponentPropsWithoutRef<'p'>) => <p className="my-0" {...props} />,
  strong: (props: ComponentPropsWithoutRef<'strong'>) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  a: (props: ComponentPropsWithoutRef<'a'>) => (
    <a
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline underline-offset-2"
      {...props}
    />
  ),
  ul: (props: ComponentPropsWithoutRef<'ul'>) => <ul className="my-2 list-disc pl-6" {...props} />,
  ol: (props: ComponentPropsWithoutRef<'ol'>) => (
    <ol className="my-2 list-decimal pl-6" {...props} />
  ),
  li: (props: ComponentPropsWithoutRef<'li'>) => <li className="my-0.5" {...props} />,
  h1: (props: ComponentPropsWithoutRef<'h1'>) => (
    <h3 className="mt-3 mb-1 font-semibold text-foreground" {...props} />
  ),
  h2: (props: ComponentPropsWithoutRef<'h2'>) => (
    <h3 className="mt-3 mb-1 font-semibold text-foreground" {...props} />
  ),
  h3: (props: ComponentPropsWithoutRef<'h3'>) => (
    <h3 className="mt-3 mb-1 font-semibold text-foreground" {...props} />
  ),
  pre: ({ className, ...props }: ComponentPropsWithoutRef<'pre'>) => (
    <pre
      {...omitNode(props)}
      className={cn(
        'my-2 overflow-x-auto rounded-md bg-surface-sunken p-3 text-[13px] leading-[18px]',
        className,
      )}
    />
  ),
  code: ({ className, ...props }: ComponentPropsWithoutRef<'code'>) => (
    <code
      {...omitNode(props)}
      className={cn(
        'font-mono text-[13px] text-foreground [:not(pre)>&]:text-inline-code',
        className,
      )}
    />
  ),
  table: (props: ComponentPropsWithoutRef<'table'>) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-[13px] leading-[18px]" {...props} />
    </div>
  ),
  th: (props: ComponentPropsWithoutRef<'th'>) => (
    <th className="px-3 py-1.5 text-left font-semibold text-foreground" {...props} />
  ),
  td: (props: ComponentPropsWithoutRef<'td'>) => <td className="px-3 py-1.5" {...props} />,
  blockquote: (props: ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote className="my-2 pl-4 text-foreground-subtle" {...props} />
  ),
};

/** 어시스턴트 응답 글입니다. 15/24, `foreground-muted`이고 마크다운을 해석합니다. */
export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={remarkPlugins}
      components={components}
      className="text-foreground-muted"
    />
  );
}
