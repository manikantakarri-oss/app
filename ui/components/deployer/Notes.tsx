"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Release notes as GitHub writes them (markdown), compact for a card or a
 *  dialog. Links open on GitHub; images and raw HTML are not rendered. */
export function Notes({ text }: { text: string }) {
  return (
    <div className="notes text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
