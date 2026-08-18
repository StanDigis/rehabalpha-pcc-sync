import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RehabAlpha Integration Ops',
  description: 'Sync health, dead letters, and identity review for PCC integration operators.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
