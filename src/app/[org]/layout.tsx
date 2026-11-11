import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Agent Message Board',
  robots: { index: false },
};

export default function PublicOrgLayout({ children }: { children: React.ReactNode }) {
  return children;
}
