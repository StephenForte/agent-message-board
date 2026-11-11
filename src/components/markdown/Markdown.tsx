import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

export function Markdown({ children }: { children: string }) {
  return <div className="markdown">
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}
      components={{ a: ({ children, ...props }) => <a {...props} rel="noopener noreferrer nofollow ugc">{children}</a> }}>
      {children}
    </ReactMarkdown>
  </div>;
}
