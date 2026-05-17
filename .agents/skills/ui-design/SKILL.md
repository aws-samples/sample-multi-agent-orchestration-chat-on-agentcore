---
name: ui-design
description: UI/UX design rules, Atomic Design placement, design tokens, component conventions, and responsive patterns for the Moca frontend. Use when creating or modifying React components, styling, or layout.
---

# UI Design Guide

UI/UX design rules and conventions for the Moca frontend. Built with React, Tailwind CSS, and Atomic Design methodology.

## Design Principles

1. **Clarity** - Immediate visual feedback, visible system state, no ambiguous labels
2. **Consistency** - Reuse existing components and patterns; do not create duplicates
3. **Efficiency** - Minimize steps; support `⌘K` Command Palette and keyboard shortcuts
4. **Accessibility** - WCAG 2.1 AA, 4.5:1 contrast, keyboard navigation, ARIA labels

## Architecture Rules

### Atomic Design Placement

| Level | Location | Description | Rule |
|-------|----------|-------------|------|
| **Atoms** | `components/ui/*/` | Smallest building blocks (Button, Input, Card, Badge, Toggle, Alert, etc.) | No business logic. Pure presentation. Highly reusable. |
| **Molecules** | `components/ui/*/` | Composed atoms (Modal, FormField, DropdownMenu, SearchSection, NavItem, etc.) | Simple interactions, internal UI state only. Reusable across features. |
| **Organisms** | `components/*.tsx`, `components/triggers/` | Feature-specific complex UI (ChatContainer, SessionSidebar, AgentForm, etc.) | May contain business logic. Connect to Zustand stores and hooks. |
| **Templates** | `layouts/` | Page-level layout structure (`MainLayout`) | Defines responsive shell, sidebar, routing outlet. |
| **Pages** | `pages/` | Route-specific content (ChatPage, AgentsPage, ToolsPage, etc.) | Connect templates with data and route params. |

### Where to place new components

- **Reusable, no business logic** → `components/ui/{ComponentName}/`
- **Feature-specific, complex** → `components/` root or `components/{feature}/`
- **Auth-related** → `features/auth/`
- **New page** → `pages/`

## Design Token System

All design tokens are defined as **CSS Custom Properties** in `src/index.css` `:root` and consumed via `tailwind.config.js`.

**Token categories**: `brand`, `action`, `surface`, `border`, `fg` (foreground/text), `feedback`

**Key rule**: Always prefer semantic tokens over raw values.

| Do ✅ | Don't ❌ |
|-------|---------|
| `bg-action-primary` | `bg-blue-600` |
| `text-fg-secondary` | `text-gray-600` |
| `border-border` | `border-gray-200` |
| `bg-feedback-error-bg` | `bg-red-50` |
| `rounded-btn` | `rounded-lg` (for buttons) |
| `shadow-elevation-2` | `shadow-md` |

**Exception**: `hover:bg-gray-100` and similar hover states where no semantic token exists.

**Reference files**: `src/index.css` (token definitions), `tailwind.config.js` (Tailwind mapping)

## Component Conventions

When creating or modifying UI components, follow these patterns. **Reference existing implementations** rather than starting from scratch:

### Standard Patterns

1. **Variant/Size style maps** — Use `Record<NonNullable<Props['variant']>, string>` for variant styles. See `Button.tsx`, `Card.tsx`.
2. **`React.forwardRef`** — Use for DOM-interacting atoms (Button, Input, Card). Always set `displayName`.
3. **`loading` prop** — Replaces icon with `Loader2` spinner, disables the button. See `Button.tsx`, `Toggle.tsx`.
4. **Icon props** — Use `LucideIcon` type from `lucide-react`. See `Button.tsx` (`leftIcon`, `rightIcon`), `IconButton.tsx` (`icon`).
5. **`className` override** — All components must accept `className` prop, applied via `cn()`.
6. **`cn()` utility** — Always use `cn()` from `lib/utils.ts` (`clsx` + `tailwind-merge`) for class composition.

### Reference Files for New Components

| Creating a... | Study this file |
|---------------|-----------------|
| New atom | `components/ui/Button/Button.tsx`, `components/ui/Card/Card.tsx` |
| New molecule | `components/ui/FormField/FormField.tsx`, `components/ui/DropdownMenu/DropdownMenu.tsx` |
| New modal | `components/ui/Modal/Modal.tsx`, `components/ui/Modal/ConfirmModal.tsx` |
| New page header | `components/ui/PageHeader/PageHeader.tsx` |

## Typography

- Font: **M PLUS Rounded 1c** (defined in `tailwind.config.js` `fontFamily.sans`)
- Body text: `text-sm text-fg-default`
- Secondary text: `text-sm text-fg-secondary`
- Labels: `text-sm font-medium text-fg-secondary`
- Page headings: `text-xl font-semibold text-fg-default`

## Responsive Design

3 breakpoints managed via `window.matchMedia` in `MainLayout.tsx` and `uiStore`:

| Breakpoint | Range | Sidebar | Header |
|------------|-------|---------|--------|
| Mobile | `< 768px` | Overlay (z-50), swipe gestures | Fixed hamburger bar |
| Narrow Desktop | `768px - 1024px` | Auto-collapsed (w-16, icon-only) | None |
| Wide Desktop | `> 1024px` | User-controlled (w-80 / w-16) | None |

- Mobile swipe: `useSwipeGesture` hook
- `PageHeader` auto-hides on mobile (returns `null`; `MainLayout` handles mobile header)
- `Modal size="xl"` renders full-screen on mobile

## State Management

- **Zustand** with 12 stores in `stores/` — 1 domain = 1 store
- Use selectors: `useAgentStore((state) => state.agents)`
- Derived selectors: `useSelectedAgent()` pattern
- Responsive UI state: `uiStore` (`isSidebarOpen`, `isMobileView`, `isNarrowDesktop`)

## Internationalization

- **react-i18next** — Config in `src/i18n/`, translations in `src/locales/`
- Usage: `const { t } = useTranslation();`
- Agent names/descriptions: `translateIfKey()` utility

## Anti-patterns (Do NOT)

- ❌ Use raw gray values (`bg-gray-200`) when a semantic token exists (`border-border`)
- ❌ Use legacy CSS classes (`.button-primary`, `.input-field`, `.message-bubble`) — use component-level Tailwind instead
- ❌ Create a new component when an existing one in `components/ui/` fits the need
- ❌ Use `any` type — use `unknown` or proper types
- ❌ Hardcode colors — always use design tokens
- ❌ Skip `className` prop on reusable components
- ❌ Forget `displayName` on `forwardRef` components