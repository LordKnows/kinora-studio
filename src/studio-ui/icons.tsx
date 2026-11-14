/* The studio's icons: one stroke weight, currentColor, sized by the caller. */

type IconProps = { size?: number };

function Svg({ size, children, fill }: { size: number; children: React.ReactNode; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {children}
    </svg>
  );
}

export function CheckIcon({ size = 13 }: IconProps) {
  return <Svg size={size}><path d="M3 8.5l3 3 7-7" /></Svg>;
}
export function CloseIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
}
export function CopyIcon({ size = 13 }: IconProps) {
  return <Svg size={size}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></Svg>;
}
export function OpenOutIcon({ size = 13 }: IconProps) {
  return <Svg size={size}><path d="M9 3h4v4M13 3L7 9M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" /></Svg>;
}
export function UploadIcon({ size = 13 }: IconProps) {
  return <Svg size={size}><path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10" /></Svg>;
}
export function WarningIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><path d="M8 2.5l6 10.5H2L8 2.5z" /><path d="M8 7v2.5M8 11.5v.5" /></Svg>;
}
export function PlusIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><path d="M8 3v10M3 8h10" /></Svg>;
}
export function ChevronIcon({ size = 12 }: IconProps) {
  return <Svg size={size}><path d="M4 6l4 4 4-4" /></Svg>;
}
export function PlayIcon({ size = 14 }: IconProps) {
  return <Svg size={size} fill><path d="M4 2.5v11l9-5.5z" /></Svg>;
}
export function ArrowUpIcon({ size = 12 }: IconProps) {
  return <Svg size={size}><path d="M8 13V3M4 7l4-4 4 4" /></Svg>;
}
export function ArrowDownIcon({ size = 12 }: IconProps) {
  return <Svg size={size}><path d="M8 3v10M4 9l4 4 4-4" /></Svg>;
}
export function BoltIcon({ size = 13 }: IconProps) {
  return <Svg size={size} fill><path d="M9 1.5L3 9h4l-1 5.5L13 7H9l1-5.5z" /></Svg>;
}
export function MenuIcon({ size = 16 }: IconProps) {
  return <Svg size={size}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></Svg>;
}
export function GridIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></Svg>;
}
/* two corners pulled apart: show it large */
export function ExpandIcon({ size = 13 }: IconProps) {
  return <Svg size={size}><path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" /></Svg>;
}
export function ArrowLeftIcon({ size = 13 }: IconProps) {
  return <Svg size={size}><path d="M13 8H3M7 4L3 8l4 4" /></Svg>;
}
/* status marks: they carry a colour where the page gives them one (.st-status, the Lint drawer) */
export function CheckCircleIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><circle cx="8" cy="8" r="6" /><path d="M5.2 8.2l2 2 3.6-4" /></Svg>;
}
export function DraftIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><path d="M10.5 2.8l2.7 2.7L6 12.7l-3.3.6.6-3.3 7.2-7.2z" /><path d="M9 4.3l2.7 2.7" /></Svg>;
}
export function ErrorIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><circle cx="8" cy="8" r="6" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></Svg>;
}
export function InfoIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><circle cx="8" cy="8" r="6" /><path d="M8 7.3v3.6M8 5v.4" /></Svg>;
}
export function BanIcon({ size = 13 }: IconProps) {
  return <Svg size={size}><circle cx="8" cy="8" r="6" /><path d="M3.8 3.8l8.4 8.4" /></Svg>;
}
export function UndoIcon({ size = 13 }: IconProps) {
  return <Svg size={size}><path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6" /><path d="M6 3.5l-3 3 3 3" /></Svg>;
}
