import type * as React from 'react';

export type IconName = 'plus' | 'x' | 'check' | 'search' | 'play' | 'stop' | 'refresh' | 'alert' | 'info' | 'shield' | 'merge' | 'branch' | 'folder' | 'bot' | 'sparkles' | 'workflow' | 'activity' | 'server' | 'sliders' | 'bell' | 'sun' | 'moon' | 'terminal' | 'diff' | 'flask' | 'file' | 'lock' | 'ext' | 'chevR' | 'chevD' | 'down' | 'msg' | 'globe' | 'grid' | 'list' | 'monitor' | 'tablet' | 'phone' | 'logo';
export type RunStatus = 'queued' | 'running' | 'awaiting' | 'succeeded' | 'failed' | 'cancelled' | 'none';
export type Tone = 'info' | 'warning' | 'danger' | 'success';

export interface IconProps { name?: IconName; d?: string; size?: 'sm' | 'md' | 'lg'; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** secondary (default) · primary: once per view · ghost · danger: outlined destructive · destructive: solid, confirm dialogs only */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  icon?: IconName;
  iconRight?: IconName;
  /** Render as an anchor (for "Open in new tab"). Pass href/target. */
  as?: 'button' | 'a';
  href?: string;
  target?: string;
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: becomes aria-label and tooltip. */
  label: string;
  size?: 'sm' | 'md';
  /** Unread dot (notifications). */
  dot?: boolean;
}
export declare function IconButton(props: IconButtonProps): React.ReactElement;

export interface StatusPillProps { status: RunStatus; children?: React.ReactNode; className?: string }
export declare function StatusPill(props: StatusPillProps): React.ReactElement;

export interface StatusDotProps { health: 'healthy' | 'building' | 'starting' | 'awaiting' | 'unhealthy' | 'stopped'; children?: React.ReactNode }
export declare function StatusDot(props: StatusDotProps): React.ReactElement;

export interface BadgeProps { variant?: 'neutral' | 'claude' | 'codex' | 'draft' | 'published'; children?: React.ReactNode; className?: string }
export declare function Badge(props: BadgeProps): React.ReactElement;

export interface ChipProps { mono?: boolean; icon?: IconName; children?: React.ReactNode; className?: string }
export declare function Chip(props: ChipProps): React.ReactElement;

export interface KbdProps { children: React.ReactNode }
export declare function Kbd(props: KbdProps): React.ReactElement;

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  help?: string;
  /** Replaces help; marks the input aria-invalid. */
  error?: string;
  mono?: boolean;
  multiline?: boolean;
  rows?: number;
}
export declare function TextField(props: TextFieldProps): React.ReactElement;

export interface SwitchProps { checked?: boolean; defaultChecked?: boolean; onChange?: (checked: boolean) => void; label?: React.ReactNode; disabled?: boolean; className?: string }
export declare function Switch(props: SwitchProps): React.ReactElement;

export interface SegmentedOption { value: string; label?: string; icon?: IconName; ariaLabel?: string }
export interface SegmentedControlProps { options: SegmentedOption[]; value?: string; defaultValue?: string; onChange?: (value: string) => void; label?: string; className?: string }
export declare function SegmentedControl(props: SegmentedControlProps): React.ReactElement;

export interface TabItem { value: string; label: string; icon?: IconName; count?: number | string; /** amber count (things waiting on the operator) */ attention?: boolean }
export interface TabsProps { items: TabItem[]; value?: string; defaultValue?: string; onChange?: (value: string) => void; label?: string; className?: string }
export declare function Tabs(props: TabsProps): React.ReactElement;

export interface CardProps { title?: React.ReactNode; actions?: React.ReactNode; /** children render edge to edge (lists, tables) */ flush?: boolean; children?: React.ReactNode; className?: string }
export declare function Card(props: CardProps): React.ReactElement;

export interface BannerProps { tone?: Tone; title?: string; icon?: IconName; action?: React.ReactNode; children?: React.ReactNode; className?: string }
export declare function Banner(props: BannerProps): React.ReactElement;

export interface ToastProps { tone?: Tone; title: string; description?: string; icon?: IconName; onDismiss?: () => void; className?: string }
export declare function Toast(props: ToastProps): React.ReactElement;

export interface EmptyStateProps { title: string; description?: React.ReactNode; icon?: IconName; illustration?: React.ReactNode; action?: React.ReactNode; tone?: 'neutral' | 'error'; className?: string }
export declare function EmptyState(props: EmptyStateProps): React.ReactElement;

export interface DialogProps { open?: boolean; title: React.ReactNode; description?: React.ReactNode; footer?: React.ReactNode; onClose?: () => void; /** alertdialog role for destructive confirms */ destructive?: boolean; /** render without overlay (docs, drawers) */ inline?: boolean; width?: number; children?: React.ReactNode; className?: string }
export declare function Dialog(props: DialogProps): React.ReactElement | null;

export interface NavItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { icon: IconName; label: string; active?: boolean; badge?: number | string; collapsed?: boolean }
export declare function NavItem(props: NavItemProps): React.ReactElement;

export interface RunTimelineProps {
  /** Defaults to Queued → Preparing worktree → Running CLI → Tests → Awaiting approval → Merged */
  steps?: Array<string | { label: string }>;
  /** Index of the active (or failed) step. */
  current?: number;
  state?: 'running' | 'awaiting' | 'failed' | 'succeeded';
  label?: string;
  className?: string;
}
export declare function RunTimeline(props: RunTimelineProps): React.ReactElement;

export interface LogLine { text: string; tone?: 'system' | 'command' | 'dim' | 'ok' | 'error' | 'warn' | 'edit' | 'tool'; section?: string }
export interface LogViewerProps { lines: LogLine[]; streaming?: boolean; reconnecting?: boolean; onJumpToLatest?: () => void; toolbar?: boolean; height?: number; className?: string }
export declare function LogViewer(props: LogViewerProps): React.ReactElement;

export interface DiffLine { type?: 'ctx' | 'add' | 'del' | 'hunk'; old?: number | string; new?: number | string; text: string }
export interface DiffViewProps { path?: string; lines: DiffLine[]; additions?: number; deletions?: number; actions?: React.ReactNode; className?: string }
export declare function DiffView(props: DiffViewProps): React.ReactElement;

export interface SkeletonProps { width?: number | string; height?: number | string; round?: boolean; className?: string }
export declare function Skeleton(props: SkeletonProps): React.ReactElement;

declare global {
  interface Window {
    AgentStudio: {
      Button: typeof Button; IconButton: typeof IconButton; Icon: typeof Icon; StatusPill: typeof StatusPill; StatusDot: typeof StatusDot;
      Badge: typeof Badge; Chip: typeof Chip; Kbd: typeof Kbd; TextField: typeof TextField; Switch: typeof Switch;
      SegmentedControl: typeof SegmentedControl; Tabs: typeof Tabs; Card: typeof Card; Banner: typeof Banner; Toast: typeof Toast;
      EmptyState: typeof EmptyState; Dialog: typeof Dialog; NavItem: typeof NavItem; RunTimeline: typeof RunTimeline;
      LogViewer: typeof LogViewer; DiffView: typeof DiffView; Skeleton: typeof Skeleton;
    };
  }
}
