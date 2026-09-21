/**
 * The workspace's frame, laid out the way VS Code lays out a window, so nothing about it
 * has to be learned: tabs over the editor with the run controls at their right, an
 * Explorer at the left, a panel of views under the editor (Problems, Output, …), a status
 * bar along the bottom, and notifications in the corner. It knows nothing about scripts —
 * `editor.ts` fills it — and it is the editor's own palette (tokens.css), not VS Code's.
 *
 * What it is for: nothing here ever pushes the text down. A message is a status bar item
 * or a notification over the corner; a list is a view of the panel, which takes its room
 * from the bottom and only when asked.
 *
 * The icons are codicons. Monaco's stylesheet carries the font (inlined into
 * `dist/monaco.js`, see `bundle/build.mjs`), so they appear once Monaco has loaded —
 * `ready()` says so, and until then the glyphs are hidden rather than drawn as boxes.
 */
import type { PluginApi } from "@scm-js/plugin-api";

type El = PluginApi["ui"]["el"];

/** Codicon code points (`monaco-editor/esm/vs/base/common/codiconsLibrary.js`); they do not move between versions. */
const ICONS = {
  play: "eb2c",
  check: "eab2",
  beaker: "ea79",
  target: "ebf8",
  ellipsis: "ea7c",
  "new-file": "ea7f",
  "new-folder": "ea80",
  folder: "ea83",
  "folder-opened": "eaf7",
  edit: "ea73",
  trash: "ea81",
  close: "ea76",
  error: "ea87",
  warning: "ea6c",
  info: "ea74",
  "chevron-down": "eab4",
  "chevron-right": "eab6",
  "screen-full": "eb4c",
  "multiple-windows": "eb23",
  sync: "ea77",
  loading: "eb19",
  pass: "eba4",
  "symbol-variable": "ea88",
  "symbol-method": "ea8c",
  "clear-all": "eabf",
  "circle-filled": "ea71",
  package: "eb29",
  files: "eaf0",
  filter: "eaf1",
  "run-all": "eb9e",
  "run-errors": "ebde",
  "circle-outline": "eabc",
  "circle-slash": "eabd",
  "pass-filled": "ebb3",
} as const;

export type IconName = keyof typeof ICONS;

export interface ShellLayout {
  sidebar: boolean;
  sidebarWidth: number;
  panel: boolean;
  panelHeight: number;
  panelView: string;
  /** Which of the sidebar's views is shown; the Explorer unless said. */
  sidebarView?: string;
}

export const DEFAULT_LAYOUT: ShellLayout = { sidebar: true, sidebarWidth: 180, panel: false, panelHeight: 180, panelView: "problems" };
/** Beside the map there is less room: a narrower Explorer and a shorter panel. */
export const COMPACT_LAYOUT: ShellLayout = { sidebar: true, sidebarWidth: 136, panel: false, panelHeight: 130, panelView: "problems" };

export interface TabSpec {
  id: string;
  label: string;
  /** Said faintly beside the label: the folder, for tabs whose files share a name. */
  about?: string;
  title?: string;
  /** Problems in the file: the label turns red and carries the count. */
  problems?: number;
  closable?: boolean;
}

export interface ActionSpec {
  icon: IconName;
  title: string;
  run(): void;
}

export interface ActionHandle {
  element: HTMLButtonElement;
  set(state: { disabled?: boolean; busy?: boolean; icon?: IconName; title?: string }): void;
}

export interface SectionHandle {
  body: HTMLElement;
  setHidden(hidden: boolean): void;
  expand(): void;
}

/** A view of the sidebar, with its icon in the activity bar. */
export interface SidebarViewHandle {
  body: HTMLElement;
  /** The count on the icon; null or 0 for none. `kind` colours it. */
  badge(count: number | null, kind?: "error"): void;
  /** Show the sidebar on this view. */
  show(): void;
}

export interface ViewHandle {
  body: HTMLElement;
  /** The count beside the view's name; null or 0 for none. */
  badge(count: number | null): void;
}

export interface StatusItemState {
  text: string;
  icon?: IconName;
  title?: string;
  kind?: "warn" | "error";
  busy?: boolean;
  onClick?: () => void;
}

export interface StatusItemHandle {
  /** null takes the item off the bar. */
  set(state: StatusItemState | null): void;
}

export interface NotificationSpec {
  /** One notification per key: the same key again replaces it. */
  key: string;
  kind: "info" | "warn" | "error";
  text: string;
  actions?: { label: string; primary?: boolean; run(): void; keep?: boolean }[];
  /** Goes by itself after this long; unset stays until dismissed. */
  timeout?: number;
}

export interface MenuItem {
  label: string;
  keys?: string;
  disabled?: boolean;
  run(): void;
}

export interface ShellOptions {
  el: El;
  compact: boolean;
  layout: ShellLayout;
  onLayout(layout: ShellLayout): void;
  onTabSelect(id: string): void;
  onTabClose(id: string): void;
}

export interface Shell {
  root: HTMLElement;
  /** Where Monaco goes. */
  editorHost: HTMLElement;
  /** The codicon font is there: show the icons. */
  ready(): void;
  setTabs(tabs: TabSpec[], active: string): void;
  icon(name: IconName): HTMLElement;
  /** A bare icon that is a button, for a row of a list. */
  iconButton(spec: ActionSpec): ActionHandle;
  action(spec: ActionSpec): ActionHandle;
  section(spec: { title: string; actions?: ActionSpec[] }): SectionHandle;
  /** Another view of the sidebar beside the Explorer: its icon joins the activity bar, which shows once there are two. */
  sidebarView(spec: { id: string; title: string; icon: IconName; actions?: ActionSpec[] }): SidebarViewHandle;
  toggleSidebar(show?: boolean): void;
  /** `onShow`: the view was put on screen — what could not be done while it was detached (scrolling to its end) can be now. */
  view(spec: { id: string; title: string; actions?: ActionSpec[]; onShow?: () => void }): ViewHandle;
  /** Show the panel, on `id` when given. */
  showPanel(id?: string): void;
  /** What the view's shortcut does: show it, or hide the panel when it is already what is shown. */
  togglePanel(id?: string): void;
  statusItem(side: "left" | "right"): StatusItemHandle;
  notify(spec: NotificationSpec): void;
  dismiss(key: string): void;
  /** Under the anchor's right end; with `at` (a pointer's clientX / clientY), where the pointer is — a context menu. */
  menu(anchor: HTMLElement, items: (MenuItem | null)[], at?: { x: number; y: number }): void;
  dispose(): void;
}

const SIDEBAR_MIN = 100;
const SIDEBAR_MAX = 420;
const PANEL_MIN = 64;

export const SHELL_STYLE = `
.tsd { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; background: var(--bg-0); color: var(--text); font-family: var(--font-ui); font-size: var(--fs-md); user-select: none; }
.tsd button { font: inherit; color: inherit; }
.tsd-i { display: inline-block; flex: none; font: normal normal normal 16px/1 codicon; text-align: center; -webkit-font-smoothing: antialiased; }
.tsd:not(.tsd-ready) .tsd-i { visibility: hidden; }
${Object.entries(ICONS).map(([name, code]) => `.tsd-i-${name}::before { content: "\\${code}"; }`).join("\n")}
.tsd-spin { animation: tsd-spin 1.2s steps(30) infinite; }
@keyframes tsd-spin { to { transform: rotate(360deg); } }

.tsd-body { flex: 1; min-height: 0; display: flex; }
.tsd-activity { flex: none; width: 40px; display: flex; flex-direction: column; align-items: stretch; background: var(--bg-2); border-right: 1px solid var(--border); }
.tsd-activity[hidden] { display: none; }
.tsd-compact .tsd-activity { width: 32px; }
.tsd-activity button { position: relative; height: 40px; border: none; border-left: 2px solid transparent; background: none; color: var(--text-faint); cursor: pointer; }
.tsd-compact .tsd-activity button { height: 34px; }
.tsd-activity button:hover { color: var(--text); }
.tsd-activity button.tsd-active { color: var(--text); border-left-color: var(--gold); }
.tsd-activity button .tsd-i { font-size: 22px; }
.tsd-compact .tsd-activity button .tsd-i { font-size: 18px; }
.tsd-activity .tsd-badge { position: absolute; right: 4px; bottom: 5px; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 7px; background: var(--sel-hi); color: var(--bg-0); font-size: 9px; font-weight: 700; line-height: 14px; text-align: center; }
.tsd-activity .tsd-badge.tsd-error { background: var(--danger); color: #fff; }
.tsd-sidebar-title .tsd-grow { flex: 1; }
.tsd-sidebar-title .tsd-icon-button { margin-left: 2px; }
.tsd-sidebar-body { flex: 1; min-height: 0; overflow: auto; }
.tsd-sidebar { flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--bg-1); overflow: hidden; }
.tsd-sidebar-title { flex: none; height: 32px; display: flex; align-items: center; padding: 0 12px 0 16px; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-dim); }
.tsd-sections { flex: 1; min-height: 0; overflow: auto; }
.tsd-section-head { display: flex; align-items: center; gap: 2px; height: 22px; padding: 0 6px 0 2px; border-top: 1px solid var(--border); font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text); cursor: pointer; }
.tsd-section-head .tsd-grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tsd-section-head .tsd-icon-button { visibility: hidden; }
.tsd-section:hover .tsd-icon-button, .tsd-section:focus-within .tsd-icon-button { visibility: visible; }
.tsd-section.tsd-collapsed .tsd-section-body { display: none; }
.tsd-section-body { padding-bottom: 6px; }
.tsd-rows { margin: 0; padding: 0; list-style: none; }
.tsd-row { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 6px 0 20px; color: var(--text-dim); white-space: nowrap; cursor: pointer; }
.tsd-row.tsd-child { padding-left: 34px; }
.tsd-row:hover { background: var(--bg-3); color: var(--text); }
.tsd-row.tsd-active { background: var(--bg-4); color: var(--text); }
.tsd-row .tsd-name { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.tsd-row .tsd-about { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-faint); font-size: var(--fs-sm); }
.tsd-row .tsd-problem, .tsd-tab .tsd-problem { color: var(--danger); }
.tsd-row .tsd-count { flex: none; margin-left: auto; color: var(--danger); font-size: var(--fs-sm); }
.tsd-row .tsd-icon-button { display: none; margin-left: 0; }
.tsd-row .tsd-row-actions { display: flex; margin-left: auto; }
.tsd-row:hover .tsd-icon-button, .tsd-row.tsd-active .tsd-icon-button { display: inline-flex; }
.tsd-row .tsd-i { font-size: 14px; }
.tsd-row.tsd-folder { gap: 4px; }
.tsd-row.tsd-drop, .tsd-rows.tsd-drop { background: var(--sel); color: var(--text); }
.tsd-row.tsd-dragged { opacity: 0.5; }
.tsd-ts { flex: none; font-size: 9px; font-weight: 700; letter-spacing: -0.02em; color: var(--sel-hi); }

.tsd-icon-button { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--radius-lg); background: none; color: var(--text-dim); cursor: pointer; }
.tsd-icon-button:hover:not(:disabled) { background: var(--bg-4); color: var(--text); }
.tsd-icon-button:disabled { opacity: 0.4; cursor: default; }
.tsd-icon-button:focus-visible { outline: none; box-shadow: var(--focus); }

.tsd-sash { flex: none; position: relative; z-index: 3; background: var(--border); }
.tsd-sash::after { content: ""; position: absolute; transition: background 0.1s 0.2s; }
.tsd-sash:hover::after, .tsd-sash.tsd-dragging::after { background: var(--sel-hi); }
.tsd-sash-v { width: 1px; cursor: ew-resize; }
.tsd-sash-v::after { top: 0; bottom: 0; left: -2px; width: 5px; }
.tsd-sash-h { height: 1px; cursor: ns-resize; }
.tsd-sash-h::after { left: 0; right: 0; top: -2px; height: 5px; }

.tsd-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.tsd-titlebar { flex: none; display: flex; align-items: stretch; height: 33px; background: var(--bg-2); border-bottom: 1px solid var(--border); }
.tsd-tabs { flex: 1; min-width: 0; display: flex; overflow-x: auto; scrollbar-width: none; }
.tsd-tabs::-webkit-scrollbar { display: none; }
.tsd-tab { flex: none; display: flex; align-items: center; gap: 6px; padding: 0 6px 0 12px; border-right: 1px solid var(--border); border-top: 1px solid transparent; color: var(--text-dim); cursor: pointer; white-space: nowrap; }
.tsd-tab:hover { color: var(--text); }
.tsd-tab.tsd-active { background: var(--bg-0); color: var(--text); border-top-color: var(--gold); margin-bottom: -1px; padding-bottom: 1px; }
.tsd-tab .tsd-icon-button { width: 20px; height: 20px; visibility: hidden; }
.tsd-tab .tsd-icon-button .tsd-i { font-size: 14px; }
.tsd-tab:hover .tsd-icon-button, .tsd-tab.tsd-active .tsd-icon-button { visibility: visible; }
.tsd-tab .tsd-pad { width: 6px; }
.tsd-tab .tsd-about { color: var(--text-faint); font-size: var(--fs-sm); }
.tsd-actions { flex: none; display: flex; align-items: center; gap: 2px; padding: 0 8px; }
.tsd-editor { flex: 1; min-height: 0; position: relative; }

.tsd-panel-area { flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--bg-1); }
.tsd-panel-head { flex: none; display: flex; align-items: center; height: 30px; padding: 0 8px 0 4px; }
.tsd-panel-tabs { flex: 1; min-width: 0; display: flex; gap: 2px; overflow: hidden; }
.tsd-panel-tab { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: none; background: none; font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em; color: var(--text-dim); cursor: pointer; border-bottom: 1px solid transparent; }
.tsd-panel-tab:hover { color: var(--text); }
.tsd-panel-tab.tsd-active { color: var(--text); border-bottom-color: var(--gold); }
.tsd-badge { min-width: 16px; padding: 1px 5px; border-radius: 9px; background: var(--bg-5); color: var(--text); font-size: 10px; line-height: 14px; text-align: center; }
.tsd-panel-actions { flex: none; display: flex; gap: 2px; }
.tsd-view { flex: 1; min-height: 0; overflow: auto; user-select: text; }
.tsd-empty { padding: 6px 20px; color: var(--text-dim); }

.tsd-statusbar { flex: none; display: flex; align-items: stretch; height: 22px; background: var(--bg-2); border-top: 1px solid var(--border); font-size: var(--fs-sm); color: var(--text-dim); overflow: hidden; }
.tsd-compact .tsd-statusbar { padding-right: 16px; }
/* The left side says what state the script is in and keeps its words; the right side gives way first, its long items by an ellipsis. */
.tsd-status-left { flex: 0 0 auto; max-width: 72%; display: flex; overflow: hidden; }
.tsd-status-right { flex: 1 1 0; min-width: 0; display: flex; justify-content: flex-end; overflow: hidden; }
.tsd-status-item { flex: none; display: flex; align-items: center; gap: 4px; padding: 0 7px; border: none; background: none; white-space: nowrap; cursor: default; }
.tsd-status-item.tsd-shrink { flex: 0 1 auto; min-width: 0; }
.tsd-status-item.tsd-shrink span:last-child { overflow: hidden; text-overflow: ellipsis; }
.tsd-status-item .tsd-i { font-size: 13px; }
button.tsd-status-item { cursor: pointer; }
button.tsd-status-item:hover { background: var(--bg-4); color: var(--text); }
.tsd-status-item.tsd-warn { background: color-mix(in srgb, var(--warn) 22%, var(--bg-2)); color: var(--warn); }
.tsd-status-item.tsd-error { color: var(--danger); }

.tsd-notifications { position: absolute; right: 10px; bottom: 30px; z-index: 20; display: flex; flex-direction: column; gap: 6px; width: min(440px, calc(100% - 20px)); pointer-events: none; }
.tsd-notification { pointer-events: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px 8px 10px 10px; background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop); user-select: text; }
.tsd-notification-row { display: flex; align-items: flex-start; gap: 8px; }
.tsd-notification-row .tsd-text { flex: 1; min-width: 0; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.tsd-notification .tsd-i-info { color: var(--sel-hi); }
.tsd-notification .tsd-i-warning { color: var(--warn); }
.tsd-notification .tsd-i-error { color: var(--danger); }
.tsd-notification-actions { display: flex; justify-content: flex-end; gap: 6px; padding-right: 2px; }
.tsd-button { height: 24px; padding: 0 10px; border: none; border-radius: var(--radius); background: var(--bg-5); color: var(--text); cursor: pointer; }
.tsd-button:hover { background: var(--border-strong); }
.tsd-button.tsd-primary { background: var(--sel); }
.tsd-button.tsd-primary:hover { background: var(--sel-hi); }

.tsd-menu { position: absolute; z-index: 30; min-width: 220px; padding: 4px; background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop); }
.tsd-menu button { display: flex; align-items: center; gap: 24px; width: 100%; height: 24px; padding: 0 10px 0 22px; border: none; border-radius: var(--radius); background: none; text-align: left; white-space: nowrap; cursor: pointer; }
.tsd-menu button:hover:not(:disabled), .tsd-menu button:focus-visible { background: var(--sel); outline: none; }
.tsd-menu button:disabled { color: var(--text-faint); cursor: default; }
.tsd-menu .tsd-grow { flex: 1; }
.tsd-menu .tsd-keys { color: var(--text-dim); font-size: var(--fs-sm); }
.tsd-menu hr { margin: 4px 0; border: none; border-top: 1px solid var(--border); }
`;

export function createShell(options: ShellOptions): Shell {
  const { el } = options;
  const layout: ShellLayout = { ...options.layout };

  const icon = (name: IconName, spin = false) => el("span", { className: `tsd-i tsd-i-${name}${spin ? " tsd-spin" : ""}`, ariaHidden: "true" });

  const iconButton = (spec: ActionSpec): ActionHandle => {
    let name = spec.icon;
    let busy = false;
    const glyph = icon(name);
    const element = el("button", { type: "button", className: "tsd-icon-button", title: spec.title, ariaLabel: spec.title, onClick: (e: MouseEvent) => { e.stopPropagation(); spec.run(); } }, glyph) as HTMLButtonElement;
    return {
      element,
      set(state) {
        if (state.icon) name = state.icon;
        if (state.busy !== undefined) busy = state.busy;
        if (state.disabled !== undefined) element.disabled = state.disabled;
        if (state.title !== undefined) { element.title = state.title; element.ariaLabel = state.title; }
        glyph.className = busy ? "tsd-i tsd-i-loading tsd-spin" : `tsd-i tsd-i-${name}`;
      },
    };
  };

  /* ── The frame ── */
  const tabsEl = el("div", { className: "tsd-tabs", role: "tablist" });
  const actionsEl = el("div", { className: "tsd-actions" });
  const editorHost = el("div", { className: "tsd-editor" });
  const sectionsEl = el("div", { className: "tsd-sections" });
  const sidebarTitle = el("div", { className: "tsd-sidebar-title" }, "Explorer");
  const sidebarHolder = el("div", { className: "tsd-sidebar-body" }, sectionsEl);
  const sidebar = el("div", { className: "tsd-sidebar" }, sidebarTitle, sidebarHolder);
  const activity = el("div", { className: "tsd-activity", role: "tablist", ariaLabel: "Views", hidden: true });
  const sidebarSash = el("div", { className: "tsd-sash tsd-sash-v" });
  const panelTabs = el("div", { className: "tsd-panel-tabs", role: "tablist" });
  const panelActions = el("div", { className: "tsd-panel-actions" });
  const panelBody = el("div", { className: "tsd-view" });
  const panelSash = el("div", { className: "tsd-sash tsd-sash-h" });
  const panel = el("div", { className: "tsd-panel-area" }, el("div", { className: "tsd-panel-head" }, panelTabs, panelActions), panelBody);
  const statusLeft = el("div", { className: "tsd-status-left" });
  const statusRight = el("div", { className: "tsd-status-right" });
  const notifications = el("div", { className: "tsd-notifications" });
  const main = el("div", { className: "tsd-main" },
    el("div", { className: "tsd-titlebar" }, tabsEl, actionsEl),
    editorHost,
    panelSash,
    panel,
  );
  const root = el("div", { className: options.compact ? "tsd tsd-compact" : "tsd" },
    el("div", { className: "tsd-body" }, activity, sidebar, sidebarSash, main),
    el("div", { className: "tsd-statusbar", role: "status" }, statusLeft, statusRight),
    notifications,
  );

  const applyLayout = () => {
    sidebar.hidden = sidebarSash.hidden = !layout.sidebar;
    sidebar.style.width = `${layout.sidebarWidth}px`;
    panel.hidden = panelSash.hidden = !layout.panel;
    panel.style.height = `${layout.panelHeight}px`;
  };
  const saveLayout = () => options.onLayout({ ...layout });

  /** Drag a sash: `move` gets the pointer's travel from where it went down. */
  const drag = (sash: HTMLElement, start: () => number, move: (from: number, dx: number, dy: number) => void) => {
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const from = start();
      const x = e.clientX, y = e.clientY;
      sash.setPointerCapture(e.pointerId);
      sash.classList.add("tsd-dragging");
      const onMove = (m: PointerEvent) => { move(from, m.clientX - x, m.clientY - y); applyLayout(); };
      const onUp = () => {
        sash.classList.remove("tsd-dragging");
        sash.removeEventListener("pointermove", onMove);
        sash.removeEventListener("pointerup", onUp);
        sash.removeEventListener("pointercancel", onUp);
        saveLayout();
      };
      sash.addEventListener("pointermove", onMove);
      sash.addEventListener("pointerup", onUp);
      sash.addEventListener("pointercancel", onUp);
    };
    sash.addEventListener("pointerdown", down);
  };
  drag(sidebarSash, () => layout.sidebarWidth, (from, dx) => {
    layout.sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.min(root.clientWidth - 200, from + dx)));
  });
  drag(panelSash, () => layout.panelHeight, (from, _dx, dy) => {
    layout.panelHeight = Math.max(PANEL_MIN, Math.min(main.clientHeight - 120, from - dy));
  });

  /* ── The sidebar's views ── */
  interface SideView { id: string; title: string; body: HTMLElement; actions: HTMLElement[]; button: HTMLButtonElement; badge: HTMLElement }
  const sideViews = new Map<string, SideView>();
  const showSide = (id: string) => {
    const v = sideViews.get(id) ?? sideViews.get("explorer");
    if (!v) return;
    layout.sidebarView = v.id;
    for (const [key, other] of sideViews) { other.button.classList.toggle("tsd-active", key === v.id && layout.sidebar); other.button.ariaSelected = String(key === v.id && layout.sidebar); }
    sidebarTitle.replaceChildren(el("span", { className: "tsd-grow" }, v.title), ...v.actions);
    sidebarHolder.replaceChildren(v.body);
  };
  const addSide = (spec: { id: string; title: string; icon: IconName; actions?: ActionSpec[] }, body: HTMLElement): SideView => {
    const badge = el("span", { className: "tsd-badge", hidden: true });
    // As VS Code: the icon of the view that is showing hides the sidebar, any other shows its view.
    const button = el("button", { type: "button", role: "tab", title: spec.title, ariaLabel: spec.title, onClick: () => {
      if (layout.sidebar && layout.sidebarView === spec.id) layout.sidebar = false;
      else { layout.sidebar = true; layout.sidebarView = spec.id; }
      applyLayout();
      showSide(layout.sidebarView ?? "explorer");
      saveLayout();
    } }, icon(spec.icon), badge) as HTMLButtonElement;
    const view: SideView = { id: spec.id, title: spec.title, body, actions: (spec.actions ?? []).map((a) => iconButton(a).element), button, badge };
    sideViews.set(spec.id, view);
    activity.append(button);
    activity.hidden = sideViews.size < 2;
    return view;
  };
  addSide({ id: "explorer", title: "Explorer", icon: "files" }, sectionsEl);

  /* ── The panel's views ── */
  const views = new Map<string, { tab: HTMLElement; badge: HTMLElement; body: HTMLElement; actions: HTMLElement[]; onShow?: () => void }>();
  const closePanel = iconButton({ icon: "close", title: "Hide the panel (Ctrl+J)", run: () => togglePanel() });
  const showView = (id: string, announce = true) => {
    const wanted = views.has(id) ? id : [...views.keys()][0];
    if (!wanted) return;
    layout.panelView = wanted;
    for (const [key, v] of views) {
      v.tab.classList.toggle("tsd-active", key === wanted);
      v.tab.ariaSelected = String(key === wanted);
    }
    const v = views.get(wanted)!;
    panelBody.replaceChildren(v.body);
    panelActions.replaceChildren(...v.actions, closePanel.element);
    if (layout.panel && announce) v.onShow?.();
  };
  const showPanel = (id?: string) => {
    layout.panel = true;
    applyLayout();
    showView(id ?? layout.panelView);
    saveLayout();
  };
  const togglePanel = (id?: string) => {
    if (layout.panel && (id === undefined || id === layout.panelView)) { layout.panel = false; applyLayout(); saveLayout(); return; }
    showPanel(id);
  };

  /* ── Menus ── */
  let closeMenu: (() => void) | null = null;
  const menu = (anchor: HTMLElement, items: (MenuItem | null)[], at?: { x: number; y: number }) => {
    closeMenu?.();
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = el("div", { className: "tsd-menu", role: "menu" });
    const close = () => {
      if (closeMenu !== close) return;
      closeMenu = null;
      box.remove();
      document.removeEventListener("pointerdown", outside, true);
    };
    const outside = (e: PointerEvent) => { if (!(e.target instanceof Node && box.contains(e.target))) close(); };
    for (const item of items) {
      if (!item) { box.append(el("hr")); continue; }
      box.append(el("button", { type: "button", role: "menuitem", disabled: !!item.disabled, onClick: () => { close(); item.run(); } },
        el("span", { className: "tsd-grow" }, item.label),
        item.keys ? el("span", { className: "tsd-keys" }, item.keys) : undefined,
      ));
    }
    box.addEventListener("keydown", (e: KeyboardEvent) => {
      const buttons = [...box.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); back?.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); buttons[(at + 1) % buttons.length]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); buttons[(at - 1 + buttons.length) % buttons.length]?.focus(); }
    });
    root.append(box);
    const r = anchor.getBoundingClientRect();
    const o = root.getBoundingClientRect();
    box.style.top = `${Math.max(4, Math.min((at ? at.y : r.bottom + 2) - o.top, o.height - box.offsetHeight - 4))}px`;
    box.style.left = `${Math.max(4, Math.min(at ? at.x - o.left : r.right - o.left - box.offsetWidth, o.width - box.offsetWidth - 4))}px`;
    closeMenu = close;
    document.addEventListener("pointerdown", outside, true);
    box.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  };

  /* ── Notifications ── */
  const shown = new Map<string, { element: HTMLElement; timer: ReturnType<typeof setTimeout> | null }>();
  const dismiss = (key: string) => {
    const n = shown.get(key);
    if (!n) return;
    if (n.timer !== null) clearTimeout(n.timer);
    n.element.remove();
    shown.delete(key);
  };
  const notify = (spec: NotificationSpec) => {
    dismiss(spec.key);
    const element = el("div", { className: "tsd-notification", role: spec.kind === "error" ? "alert" : "status" },
      el("div", { className: "tsd-notification-row" },
        icon(spec.kind === "warn" ? "warning" : spec.kind),
        el("span", { className: "tsd-text" }, spec.text),
        iconButton({ icon: "close", title: "Dismiss", run: () => dismiss(spec.key) }).element,
      ),
      spec.actions?.length
        ? el("div", { className: "tsd-notification-actions" }, ...spec.actions.map((a) =>
            el("button", { type: "button", className: a.primary ? "tsd-button tsd-primary" : "tsd-button", onClick: () => { if (!a.keep) dismiss(spec.key); a.run(); } }, a.label)))
        : undefined,
    );
    notifications.append(element);
    shown.set(spec.key, { element, timer: spec.timeout ? setTimeout(() => dismiss(spec.key), spec.timeout) : null });
  };

  applyLayout();
  showSide("explorer");

  return {
    root,
    editorHost,
    ready: () => root.classList.add("tsd-ready"),
    icon: (name) => icon(name),
    iconButton,
    setTabs(tabs, active) {
      tabsEl.replaceChildren(...tabs.map((t) => {
        const on = t.id === active;
        const tab = el("div", {
          className: on ? "tsd-tab tsd-active" : "tsd-tab", role: "tab", ariaSelected: String(on), title: t.title ?? t.label,
          onClick: () => options.onTabSelect(t.id),
          // The middle button closes a tab, as it does everywhere else.
          onAuxClick: (e: MouseEvent) => { if (e.button === 1 && t.closable) { e.preventDefault(); options.onTabClose(t.id); } },
        },
          el("span", { className: "tsd-ts" }, "TS"),
          el("span", { className: t.problems ? "tsd-problem" : undefined }, t.problems ? `${t.label} ${t.problems}` : t.label),
          t.about ? el("span", { className: "tsd-about" }, t.about) : undefined,
          t.closable ? iconButton({ icon: "close", title: "Close", run: () => options.onTabClose(t.id) }).element : el("span", { className: "tsd-pad" }),
        );
        if (on) queueMicrotask(() => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
        return tab;
      }));
    },
    action(spec) {
      const handle = iconButton(spec);
      actionsEl.append(handle.element);
      return handle;
    },
    section(spec) {
      const body = el("div", { className: "tsd-section-body" });
      const chevron = icon("chevron-down");
      const section = el("div", { className: "tsd-section" });
      const head = el("div", { className: "tsd-section-head", role: "button", tabIndex: 0, ariaExpanded: "true" },
        chevron, el("span", { className: "tsd-grow" }, spec.title), ...(spec.actions ?? []).map((a) => iconButton(a).element));
      const setCollapsed = (collapsed: boolean) => {
        section.classList.toggle("tsd-collapsed", collapsed);
        chevron.className = `tsd-i tsd-i-${collapsed ? "chevron-right" : "chevron-down"}`;
        head.ariaExpanded = String(!collapsed);
      };
      head.addEventListener("click", () => setCollapsed(!section.classList.contains("tsd-collapsed")));
      head.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); head.click(); } });
      section.append(head, body);
      sectionsEl.append(section);
      return { body, setHidden: (hidden) => { section.hidden = hidden; }, expand: () => setCollapsed(false) };
    },
    sidebarView(spec) {
      const body = el("div", { className: "tsd-sections" });
      const view = addSide(spec, body);
      if (layout.sidebarView === spec.id) showSide(spec.id);
      return {
        body,
        badge(count, kind) { view.badge.hidden = !count; view.badge.textContent = count ? String(count) : ""; view.badge.classList.toggle("tsd-error", kind === "error"); },
        show() { layout.sidebar = true; applyLayout(); showSide(spec.id); saveLayout(); },
      };
    },
    toggleSidebar(show) {
      layout.sidebar = show ?? !layout.sidebar;
      applyLayout();
      showSide(layout.sidebarView ?? "explorer");
      saveLayout();
    },
    view(spec) {
      const badge = el("span", { className: "tsd-badge", hidden: true });
      const tab = el("button", { type: "button", className: "tsd-panel-tab", role: "tab", onClick: () => showPanel(spec.id) }, spec.title, badge);
      const body = el("div");
      views.set(spec.id, { tab, badge, body, actions: (spec.actions ?? []).map((a) => iconButton(a).element), onShow: spec.onShow });
      panelTabs.append(tab);
      // Not announced: the caller is still putting itself together, and fills the view after.
      if (views.size === 1 || spec.id === layout.panelView) showView(spec.id, false);
      return { body, badge: (count) => { badge.hidden = !count; badge.textContent = count ? String(count) : ""; } };
    },
    showPanel,
    togglePanel,
    statusItem(side) {
      const slot = el("span", { hidden: true, style: "display: contents" });
      (side === "left" ? statusLeft : statusRight).append(slot);
      return {
        set(state) {
          slot.hidden = !state;
          if (!state) { slot.replaceChildren(); return; }
          const kind = state.kind ? ` tsd-${state.kind}` : "";
          const children = [state.busy ? icon("loading", true) : state.icon ? icon(state.icon) : undefined, state.text ? el("span", undefined, state.text) : undefined];
          slot.replaceChildren(state.onClick
            ? el("button", { type: "button", className: `tsd-status-item${kind}`, title: state.title ?? "", onClick: state.onClick }, ...children)
            : el("span", { className: `tsd-status-item tsd-shrink${kind}`, title: state.title ?? state.text }, ...children));
        },
      };
    },
    notify,
    dismiss,
    menu,
    dispose() {
      closeMenu?.();
      for (const key of [...shown.keys()]) dismiss(key);
    },
  };
}
