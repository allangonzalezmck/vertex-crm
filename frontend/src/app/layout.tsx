/**
 * @file frontend/src/app/layout.tsx
 * @description Next.js root layout — applies Aura tokens, Inter font, metadata.
 */

import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import '../styles/aura-tokens.css';
import { ToastContainer } from '@/components/aura';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    template: '%s | Vertex CRM',
    default: 'Vertex CRM',
  },
  description: 'AI-powered CRM platform for modern sales teams',
  robots: 'noindex',
};

export const viewport: Viewport = {
  themeColor: '#4F46E5',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="antialiased bg-[var(--surface-base)] text-[var(--text-primary)]">
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
