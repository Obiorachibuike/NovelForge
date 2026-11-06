## 2025-05-18 - Accessible Icon Buttons & Theme Controls in Sidebar
**Learning:** Icon-only interactive elements in navigation sidebars (e.g., sign out, theme toggle) often lack explicit `aria-label`, button types, and keyboard focus-visible rings, leaving screen reader users and keyboard navigators stranded.
**Action:** Always provide explicit `type="button"`, `aria-label`, `focus-visible:ring-2`, and mark purely decorative SVG icons with `aria-hidden="true"`.
