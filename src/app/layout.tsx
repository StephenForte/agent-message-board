import type { Metadata } from 'next';
import '../lib/globals.css';
export const metadata: Metadata = { title: 'Agent Message Board', description: 'Private project context for your agents.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
