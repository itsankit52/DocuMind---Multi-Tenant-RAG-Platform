/**
 * Safe rendering of assistant text. react-markdown builds React elements (no innerHTML)
 * and does not render raw HTML; its default URL transform drops javascript: and similar
 * schemes. Images are not rendered to avoid loading remote content from model output.
 */

import Markdown from 'react-markdown';

const components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
  img: ({ alt }) => <span>{alt ? `[image: ${alt}]` : ''}</span>,
  pre: ({ node, ...props }) => <pre className="code-block" {...props} />,
};

export function MessageContent({ text }) {
  return (
    <div className="markdown">
      <Markdown skipHtml components={components}>{text || ''}</Markdown>
    </div>
  );
}
