import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Panorama',
  description: 'Unified open-source platform for IT asset + operational fleet management.',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <main className="panorama-main">{children}</main>
      </body>
    </html>
  );
}
