'use client';

/**
 * @file frontend/src/components/aura/Sidebar.tsx
 * @description Aura Sidebar — primary navigation for Vertex CRM.
 * Collapsible with smooth animation. Keyboard accessible with ARIA nav roles.
 * Active state detection via Next.js usePathname.
 */

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, Users, UserCircle2, Building2, TrendingUp,
  Zap, MessageSquare, Settings, ChevronLeft, ChevronRight,
  BarChart3, Workflow, CreditCard, LogOut, Bell, Search,
  PanelLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  href: string;
  icon: React.ElementType;
  badge?: string | number;
  children?: NavItem[];
}

interface SidebarProps {
  tenantName: string;
  tenantLogoUrl?: string;
  userAvatarUrl?: string;
  userName: string;
  userEmail: string;
  onSignOut: () => void;
}

// ─── Navigation Structure ─────────────────────────────────────────────────────

const NAV_ITEMS: NavItem[] = [
  {
    label: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
  },
  {
    label: 'Leads',
    href: '/leads',
    icon: Users,
  },
  {
    label: 'Contacts',
    href: '/contacts',
    icon: UserCircle2,
  },
  {
    label: 'Accounts',
    href: '/accounts',
    icon: Building2,
  },
  {
    label: 'Deals',
    href: '/deals',
    icon: TrendingUp,
  },
  {
    label: 'Activities',
    href: '/activities',
    icon: Zap,
  },
];

const INTEL_ITEMS: NavItem[] = [
  {
    label: 'Marketing Hub',
    href: '/marketing',
    icon: BarChart3,
  },
  {
    label: 'AI Agent',
    href: '/agent',
    icon: MessageSquare,
  },
  {
    label: 'Automations',
    href: '/automations',
    icon: Workflow,
  },
];

const ADMIN_ITEMS: NavItem[] = [
  {
    label: 'Settings',
    href: '/settings',
    icon: Settings,
  },
  {
    label: 'Billing',
    href: '/billing',
    icon: CreditCard,
  },
];

// ─── Sub-Components ───────────────────────────────────────────────────────────

function NavItemRow({
  item,
  collapsed,
}: {
  item: NavItem;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;

  return (
    <li>
      <Link
        href={item.href}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'group relative flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)]',
          'text-[var(--text-secondary)] font-medium text-[13.5px]',
          'transition-colors duration-[var(--transition-fast)]',
          'hover:bg-[var(--surface-sidebar-item-hover)] hover:text-[var(--text-primary)]',
          isActive && 'bg-[var(--surface-sidebar-item-active)] text-[var(--text-brand)]',
          collapsed && 'justify-center px-2'
        )}
        title={collapsed ? item.label : undefined}
      >
        {/* Active indicator bar */}
        {isActive && (
          <motion.span
            layoutId="sidebar-active-indicator"
            className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-[var(--color-brand-600)]"
          />
        )}

        <Icon
          size={16}
          className={cn(
            'flex-shrink-0 transition-colors',
            isActive ? 'text-[var(--color-brand-600)]' : 'text-[var(--color-gray-400)] group-hover:text-[var(--text-primary)]'
          )}
          aria-hidden="true"
        />

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.15 }}
              className="flex-1 overflow-hidden whitespace-nowrap"
            >
              {item.label}
            </motion.span>
          )}
        </AnimatePresence>

        {!collapsed && item.badge !== undefined && (
          <span className="ml-auto flex-shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--color-brand-100)] text-[var(--color-brand-700)]">
            {item.badge}
          </span>
        )}

        {/* Tooltip when collapsed */}
        {collapsed && (
          <span
            role="tooltip"
            className="absolute left-full ml-3 px-2 py-1 rounded-[var(--radius-sm)] text-xs font-medium
                       bg-[var(--surface-tooltip)] text-[var(--text-on-tooltip)]
                       pointer-events-none opacity-0 group-hover:opacity-100
                       transition-opacity duration-[var(--transition-fast)]
                       whitespace-nowrap z-[var(--z-tooltip)]"
          >
            {item.label}
          </span>
        )}
      </Link>
    </li>
  );
}

function NavSection({
  label,
  items,
  collapsed,
}: {
  label: string;
  items: NavItem[];
  collapsed: boolean;
}) {
  return (
    <div className="mb-4">
      {!collapsed && (
        <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          {label}
        </p>
      )}
      {collapsed && <div className="my-2 border-t border-[var(--border-subtle)]" />}
      <ul className="space-y-0.5" role="list">
        {items.map(item => (
          <NavItemRow key={item.href} item={item} collapsed={collapsed} />
        ))}
      </ul>
    </div>
  );
}

// ─── Main Sidebar ─────────────────────────────────────────────────────────────

export function Sidebar({
  tenantName,
  tenantLogoUrl,
  userAvatarUrl,
  userName,
  userEmail,
  onSignOut,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 56 : 240 }}
      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
      className="flex flex-col h-screen bg-[var(--surface-sidebar)] border-r border-[var(--border-default)]
                 relative flex-shrink-0 overflow-hidden"
      aria-label="Primary navigation"
    >
      {/* Logo / Tenant Name */}
      <div className={cn(
        'flex items-center border-b border-[var(--border-subtle)] h-14',
        collapsed ? 'justify-center px-3' : 'px-4 gap-3'
      )}>
        <div className="flex-shrink-0 w-7 h-7 rounded-[var(--radius-md)] bg-gradient-to-br from-[var(--color-brand-600)] to-[var(--color-brand-800)] flex items-center justify-center">
          <span className="text-white text-xs font-bold">N</span>
        </div>

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
              className="font-semibold text-[14px] text-[var(--text-primary)] truncate"
            >
              {tenantName}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-4" aria-label="Main">
        <NavSection label="CRM" items={NAV_ITEMS} collapsed={collapsed} />
        <NavSection label="Intelligence" items={INTEL_ITEMS} collapsed={collapsed} />
        <NavSection label="Admin" items={ADMIN_ITEMS} collapsed={collapsed} />
      </nav>

      {/* User footer */}
      <div className={cn(
        'flex items-center border-t border-[var(--border-subtle)] p-3 gap-3',
        collapsed && 'justify-center'
      )}>
        {/* Avatar */}
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-[var(--color-brand-400)] to-[var(--color-brand-600)] overflow-hidden">
          {userAvatarUrl ? (
            <img src={userAvatarUrl} alt={userName} className="w-full h-full object-cover" />
          ) : (
            <span className="flex items-center justify-center h-full text-white text-xs font-semibold">
              {userName.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
              className="flex-1 min-w-0"
            >
              <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">{userName}</p>
              <p className="text-[11px] text-[var(--text-tertiary)] truncate">{userEmail}</p>
            </motion.div>
          )}
        </AnimatePresence>

        {!collapsed && (
          <button
            onClick={onSignOut}
            className="flex-shrink-0 p-1 rounded hover:bg-[var(--action-ghost-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-danger)]
                       transition-colors duration-[var(--transition-fast)]"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={14} />
          </button>
        )}
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="absolute top-[52px] -right-3 z-10
                   w-6 h-6 rounded-full bg-[var(--surface-card)] border border-[var(--border-default)]
                   flex items-center justify-center
                   text-[var(--text-tertiary)] hover:text-[var(--text-primary)]
                   shadow-[var(--shadow-sm)]
                   transition-colors duration-[var(--transition-fast)]"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>
    </motion.aside>
  );
}
