# Vertex CRM — Aura Design System
## Doc 4: Design Tokens & Component Specifications

---

## 1. Brand Color Tokens

### Primary Palette
```css
/* Primary — Deep Violet */
--color-primary-50:  #EEF2FF;
--color-primary-100: #E0E7FF;
--color-primary-200: #C7D2FE;
--color-primary-300: #A5B4FC;
--color-primary-400: #818CF8;
--color-primary-500: #6366F1;  /* hover */
--color-primary-600: #4F46E5;  /* BASE BRAND */
--color-primary-700: #4338CA;
--color-primary-800: #3730A3;  /* active/pressed */
--color-primary-900: #312E81;
--color-primary-950: #1E1B4B;
```

### Semantic Tokens
```css
/* Success */
--color-success-50:  #ECFDF5;
--color-success-100: #D1FAE5;
--color-success-500: #10B981;  /* base */
--color-success-600: #059669;
--color-success-700: #047857;

/* Warning */
--color-warning-50:  #FFFBEB;
--color-warning-100: #FEF3C7;
--color-warning-500: #F59E0B;  /* base */
--color-warning-600: #D97706;
--color-warning-700: #B45309;

/* Danger */
--color-danger-50:   #FEF2F2;
--color-danger-100:  #FEE2E2;
--color-danger-500:  #EF4444;  /* base */
--color-danger-600:  #DC2626;
--color-danger-700:  #B91C1C;

/* Info */
--color-info-50:     #EFF6FF;
--color-info-100:    #DBEAFE;
--color-info-500:    #3B82F6;  /* base */
--color-info-600:    #2563EB;
--color-info-700:    #1D4ED8;
```

### Neutral Scale
```css
--color-neutral-0:   #FFFFFF;
--color-neutral-50:  #FAFAFA;
--color-neutral-100: #F4F4F5;
--color-neutral-200: #E4E4E7;
--color-neutral-300: #D4D4D8;
--color-neutral-400: #A1A1AA;
--color-neutral-500: #71717A;
--color-neutral-600: #52525B;
--color-neutral-700: #3F3F46;
--color-neutral-800: #27272A;
--color-neutral-900: #18181B;
--color-neutral-950: #09090B;
```

### Semantic Alias Tokens (what components consume)
```css
:root {
  /* Backgrounds */
  --bg-base:         var(--color-neutral-0);
  --bg-subtle:       var(--color-neutral-50);
  --bg-muted:        var(--color-neutral-100);
  --bg-emphasis:     var(--color-neutral-200);

  /* Surfaces */
  --surface-overlay: rgba(255, 255, 255, 0.95);
  --surface-card:    var(--color-neutral-0);
  --surface-sidebar: var(--color-primary-950);

  /* Text */
  --text-primary:    var(--color-neutral-900);
  --text-secondary:  var(--color-neutral-500);
  --text-disabled:   var(--color-neutral-300);
  --text-inverse:    var(--color-neutral-0);
  --text-brand:      var(--color-primary-600);
  --text-link:       var(--color-primary-600);

  /* Borders */
  --border-subtle:   var(--color-neutral-100);
  --border-default:  var(--color-neutral-200);
  --border-strong:   var(--color-neutral-300);
  --border-brand:    var(--color-primary-600);

  /* Actions */
  --action-primary:          var(--color-primary-600);
  --action-primary-hover:    var(--color-primary-500);
  --action-primary-active:   var(--color-primary-800);
  --action-primary-text:     var(--color-neutral-0);
  --action-destructive:      var(--color-danger-600);
  --action-destructive-hover:var(--color-danger-700);
}

/* Dark Mode Overrides */
[data-theme="dark"] {
  --bg-base:         var(--color-neutral-950);
  --bg-subtle:       var(--color-neutral-900);
  --bg-muted:        var(--color-neutral-800);
  --bg-emphasis:     var(--color-neutral-700);

  --surface-card:    var(--color-neutral-900);
  --surface-sidebar: #0F0E1A;  /* deeper than neutral-950 */
  --surface-overlay: rgba(9, 9, 11, 0.95);

  --text-primary:    var(--color-neutral-50);
  --text-secondary:  var(--color-neutral-400);
  --text-disabled:   var(--color-neutral-600);

  --border-subtle:   var(--color-neutral-800);
  --border-default:  var(--color-neutral-700);
  --border-strong:   var(--color-neutral-600);
}
```

---

## 2. Typography Scale

### Font
```css
/* Font: Inter (Google Fonts) */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');

:root {
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
}
```

### Modular Scale (4px base, 1.25 ratio)
```css
:root {
  /* Size tokens */
  --text-xs:   0.75rem;    /* 12px — captions, labels */
  --text-sm:   0.875rem;   /* 14px — body small, table cells */
  --text-base: 1rem;       /* 16px — body, inputs */
  --text-lg:   1.25rem;    /* 20px — subheadings */
  --text-xl:   1.5rem;     /* 24px — section headers */
  --text-2xl:  2rem;       /* 32px — page titles */
  --text-3xl:  2.5rem;     /* 40px — hero / dashboard metrics */

  /* Weight tokens (Inter subset) */
  --font-normal:  400;
  --font-medium:  500;
  --font-semibold:600;

  /* Line heights */
  --leading-tight:  1.25;
  --leading-snug:   1.375;
  --leading-normal: 1.5;
  --leading-relaxed:1.625;

  /* Letter spacing */
  --tracking-tight: -0.025em;
  --tracking-normal: 0;
  --tracking-wide:   0.025em;
  --tracking-wider:  0.05em;
  --tracking-widest: 0.1em;
}

/* Semantic Text Styles */
.text-display  { font-size: var(--text-3xl); font-weight: var(--font-semibold); line-height: var(--leading-tight); letter-spacing: var(--tracking-tight); }
.text-heading-1{ font-size: var(--text-2xl); font-weight: var(--font-semibold); line-height: var(--leading-tight); }
.text-heading-2{ font-size: var(--text-xl);  font-weight: var(--font-semibold); line-height: var(--leading-snug); }
.text-heading-3{ font-size: var(--text-lg);  font-weight: var(--font-medium);   line-height: var(--leading-snug); }
.text-body     { font-size: var(--text-base);font-weight: var(--font-normal);   line-height: var(--leading-normal); }
.text-body-sm  { font-size: var(--text-sm);  font-weight: var(--font-normal);   line-height: var(--leading-normal); }
.text-label    { font-size: var(--text-sm);  font-weight: var(--font-medium);   line-height: var(--leading-tight); }
.text-caption  { font-size: var(--text-xs);  font-weight: var(--font-normal);   line-height: var(--leading-normal); letter-spacing: var(--tracking-wide); }
.text-overline { font-size: var(--text-xs);  font-weight: var(--font-semibold); line-height: var(--leading-tight); letter-spacing: var(--tracking-widest); text-transform: uppercase; }
```

---

## 3. Spacing Scale

```css
:root {
  /* 4px base grid */
  --space-0:   0;
  --space-px:  1px;
  --space-0-5: 0.125rem;  /* 2px */
  --space-xs:  0.25rem;   /* 4px  — xs */
  --space-sm:  0.5rem;    /* 8px  — sm */
  --space-md:  1rem;      /* 16px — md */
  --space-lg:  1.5rem;    /* 24px — lg */
  --space-xl:  2.5rem;    /* 40px — xl */
  --space-2xl: 4rem;      /* 64px — 2xl */
  --space-3xl: 6rem;      /* 96px */
  --space-4xl: 8rem;      /* 128px */
}
```

---

## 4. Border Radius

```css
:root {
  --radius-none: 0;
  --radius-sm:   0.375rem;  /* 6px */
  --radius-md:   0.5rem;    /* 8px */
  --radius-lg:   0.75rem;   /* 12px */
  --radius-xl:   1rem;      /* 16px */
  --radius-pill: 9999px;
  --radius-full: 9999px;
}
```

---

## 5. Shadows

```css
:root {
  --shadow-sm:  0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md:  0 4px 6px rgba(0, 0, 0, 0.07), 0 2px 4px rgba(0, 0, 0, 0.06);
  --shadow-lg:  0 10px 15px rgba(0, 0, 0, 0.10), 0 4px 6px rgba(0, 0, 0, 0.05);
  --shadow-xl:  0 20px 25px rgba(0, 0, 0, 0.10), 0 8px 10px rgba(0, 0, 0, 0.04);
  --shadow-inner: inset 0 2px 4px rgba(0, 0, 0, 0.06);
  --shadow-focus: 0 0 0 3px rgba(79, 70, 229, 0.25);  /* primary with 25% opacity */
  --shadow-focus-danger: 0 0 0 3px rgba(239, 68, 68, 0.25);
}

[data-theme="dark"] {
  --shadow-sm:  0 1px 2px rgba(0, 0, 0, 0.30);
  --shadow-md:  0 4px 6px rgba(0, 0, 0, 0.40);
  --shadow-lg:  0 10px 15px rgba(0, 0, 0, 0.50);
  --shadow-xl:  0 20px 25px rgba(0, 0, 0, 0.50);
}
```

---

## 6. Animation & Motion

```css
:root {
  /* Durations */
  --duration-instant:  50ms;
  --duration-fast:     100ms;
  --duration-normal:   200ms;
  --duration-slow:     300ms;
  --duration-slower:   500ms;

  /* Easings */
  --ease-in-out:     cubic-bezier(0.4, 0, 0.2, 1);
  --ease-in:         cubic-bezier(0.4, 0, 1, 1);
  --ease-out:        cubic-bezier(0, 0, 0.2, 1);
  --ease-spring:     cubic-bezier(0.34, 1.56, 0.64, 1);  /* slight overshoot */

  /* Framer Motion presets (use as transition prop) */
  /* fast: { duration: 0.1, ease: [0.4, 0, 0.2, 1] } */
  /* normal: { duration: 0.2, ease: [0.4, 0, 0.2, 1] } */
  /* spring: { type: 'spring', stiffness: 300, damping: 30 } */
}

/* Reduce motion for accessibility */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 7. Dashboard Chart Palette (Color-Blind Safe)

```css
:root {
  --chart-1: #4F46E5;  /* deep violet — primary series */
  --chart-2: #06B6D4;  /* cyan — secondary series */
  --chart-3: #F59E0B;  /* amber — tertiary */
  --chart-4: #10B981;  /* emerald — quaternary */
  --chart-5: #EC4899;  /* pink — quinary */
  --chart-6: #8B5CF6;  /* purple — senary */

  /* Gradient fills for area charts */
  --chart-1-gradient: linear-gradient(180deg, rgba(79, 70, 229, 0.3) 0%, rgba(79, 70, 229, 0) 100%);
  --chart-2-gradient: linear-gradient(180deg, rgba(6, 182, 212, 0.3) 0%, rgba(6, 182, 212, 0) 100%);
}
```

**Color-blind verification**: Tested against Deuteranopia, Protanopia, and Tritanopia using Coblis. Violet and cyan are distinguishable in all three. Amber and emerald are supplemented with pattern fills in critical contexts.

---

## 8. Component Specifications

### Button

```
Variants: primary | secondary | ghost | destructive | link
Sizes: sm (h=32px, px=12px, text-sm) | md (h=40px, px=16px, text-base) | lg (h=48px, px=24px, text-lg)
States: default | hover | active | focus | loading | disabled

Accessibility:
  - role="button" (or <button> element)
  - aria-disabled when disabled (not HTML disabled, to preserve focus)
  - aria-busy + spinner when loading
  - Focus ring: var(--shadow-focus)
  - Keyboard: Space/Enter to activate

Loading state: Replace text with spinner, maintain button width (no layout shift)
Icon support: leading/trailing slot, 16px icons in sm/md, 20px in lg
```

### Input

```
Variants: default | error | success | disabled
Sizes: sm (h=32px) | md (h=40px) | lg (h=48px)
States: default | focused | filled | error | disabled

Structure:
  Label (text-label, text-primary)
  ├─ Optional: required indicator (*)
  Input wrapper (border, bg-base, radius-md)
  ├─ Leading icon slot (optional)
  ├─ <input> element
  └─ Trailing icon/action slot (optional)
  Helper text (text-caption, text-secondary) OR Error message (text-caption, text-danger)

Accessibility:
  - <label> associated via htmlFor/id
  - aria-describedby → helper/error text
  - aria-invalid="true" on error state
  - aria-required on required fields
```

### DataTable

```
Features: sortable columns, row selection (checkbox), pagination, column visibility,
          row actions (dropdown), sticky header, loading skeleton, empty state,
          search/filter row, export (CSV)

Accessibility:
  - role="grid" with role="gridcell", role="columnheader"
  - aria-sort on sortable headers (ascending/descending/none)
  - aria-selected on rows
  - Keyboard: arrow keys navigate cells, Space to select row, Enter to open row

Column types: text | number | date | badge | avatar | actions | custom
Number formatting: locale-aware (Intl.NumberFormat)
Date formatting: relative (2h ago) for recent, absolute for older
```

### Sidebar

```
Variants: expanded (240px) | collapsed (64px, icon-only) | mobile (overlay, full-width)
Sections: navigation items, workspace switcher, user menu at bottom
Animation: smooth width transition (300ms ease-out) on expand/collapse
Active state: solid left border (3px, --color-primary-600) + bg-primary-50

Structure:
  ├─ Logo/wordmark (expanded) | Icon only (collapsed)
  ├─ Navigation items (grouped by section)
  │   ├─ Icon (20px, always visible)
  │   ├─ Label (visible when expanded)
  │   └─ Badge (notifications, always visible)
  ├─ Spacer
  └─ User profile (avatar + name/email when expanded)

Accessibility:
  - role="navigation" aria-label="Main navigation"
  - aria-current="page" on active item
  - aria-expanded on collapse toggle
```

### Modal

```
Variants: sm (448px) | md (560px) | lg (768px) | xl (1024px) | full
Animation: scale(0.95) + opacity(0) → scale(1) + opacity(1) (200ms ease-out)
Backdrop: rgba(0,0,0,0.5), blurred (backdrop-filter: blur(4px))

Accessibility:
  - role="dialog" aria-modal="true"
  - aria-labelledby → modal title
  - Focus trap (Tab/Shift+Tab cycle within modal)
  - Escape key closes
  - Return focus to trigger on close
  - Prevent body scroll when open
```

### Toast

```
Position: top-right (desktop), top-center (mobile)
Variants: success | warning | error | info
Auto-dismiss: 5s (adjustable per toast)
Stack: up to 3 visible, queue beyond
Animation: slide-in from right + fade, slide-out to right

Accessibility:
  - role="alert" for error/warning
  - role="status" aria-live="polite" for success/info
  - Pause timer on hover/focus
  - Manual dismiss button always present
  - Screen reader: announce toast content
```

### Badge

```
Variants: solid | soft | outline
Colors: primary | success | warning | danger | info | neutral
Sizes: sm (px=8, py=2, text-xs) | md (px=10, py=4, text-xs) | lg (px=12, py=6, text-sm)
Optional: leading dot (pulsing for "live") | leading icon | trailing icon

Accessibility:
  - For status badges: pair with text (not color-only)
  - aria-label when icon-only
```

---

## 9. Dashboard Layout Grids

### Analytics Grid
```
Container: max-width 1440px, px=24px (mobile: px=16px)
KPI strip: 4 cards at 1/4 width each (2 col on tablet, 1 col on mobile)
Chart area: 2/3 width main + 1/3 width sidebar (stacks on tablet)
Data table: full width below charts
Gutter: 16px between all grid items
```

### Kanban
```
Container: full width, horizontal scroll
Column width: 280px (fixed)
Column gutter: 12px
Card: radius-lg, shadow-sm, drag handle on hover
Card fields: title, assignee avatar, due date, priority badge
Drag-and-drop: react-beautiful-dnd or @dnd-kit/core
```

### Split Pane
```
Left pane: 360px (list/index)
Right pane: flex-1 (detail view)
Divider: 1px border-subtle, hover highlight
Mobile: stack vertically, back navigation
```

---

## 10. Icon System

```
Library: Lucide React (consistent stroke-based, MIT license)
Sizes: 16px (sm, inline) | 20px (md, UI) | 24px (lg, nav) | 32px (xl, empty states)
Stroke width: 1.5px (all sizes — visual consistency)
Color: inherit from parent (currentColor)

Usage rules:
  - Never use icons as sole conveyors of meaning (always pair with text or aria-label)
  - Navigation icons: fixed set (no random icons per section)
  - Action icons: consistent (Edit=Pencil, Delete=Trash2, Add=Plus, Close=X)
```
