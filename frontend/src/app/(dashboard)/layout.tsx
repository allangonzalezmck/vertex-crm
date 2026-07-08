'use client';

/**
 * @file frontend/src/app/(dashboard)/layout.tsx
 * @description Dashboard shell layout — Sidebar + main content area.
 * Wraps all authenticated pages. Handles auth guard and tenant context.
 */

import React from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/aura';
import { useAuthStore } from '@/stores/auth.store';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, tenant, signOut, isLoading } = useAuthStore();

  // Auth guard
  React.useEffect(() => {
    if (!isLoading && !user) {
      router.replace('/login');
    }
  }, [user, isLoading, router]);

  const handleSignOut = async () => {
    await signOut();
    router.replace('/login');
  };

  // Loading state
  if (isLoading || !user) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--surface-base)]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-[var(--radius-md)] bg-gradient-to-br from-[var(--color-brand-600)] to-[var(--color-brand-800)] animate-pulse" />
          <p className="text-[13px] text-[var(--text-tertiary)]">Loading Vertex CRM…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        tenantName={tenant?.name ?? 'Vertex CRM'}
        tenantLogoUrl={tenant?.logoUrl}
        userName={user.displayName ?? user.email}
        userEmail={user.email}
        userAvatarUrl={user.avatarUrl}
        onSignOut={handleSignOut}
      />
      <main
        id="main-content"
        className="flex-1 overflow-y-auto bg-[var(--surface-base)] focus:outline-none"
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  );
}
