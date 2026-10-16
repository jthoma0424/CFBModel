import './globals.css';
import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'CFB Model', description: 'College football power ratings vs. DraftKings spreads' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">🏈 CFB Model</Link>
          <nav>
            <Link href="/">Slate</Link>
            <Link href="/rankings">Power Rankings</Link>
            <Link href="/performance">Performance</Link>
            <Link href="/bets">Bets</Link>
            <Link href="/admin">Admin</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
