/**
 * 内联 SVG 图标（lucide 风格：24 viewBox、stroke=currentColor、1.8 线宽）。
 *
 * 刻意不引图标库：整套界面只用到十几个图标，内联 SVG 零依赖、跟随主题色
 * （currentColor）、也不会给包体添上几十 KB。用 `size` 控制像素边长。
 */

interface IconProps {
  size?: number;
  className?: string;
}

function base(size: number | undefined, className: string | undefined) {
  return {
    width: size ?? 16,
    height: size ?? 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

export const IconChevronRight = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}><path d="m9 18 6-6-6-6" /></svg>
);

export const IconChevronDown = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}><path d="m6 9 6 6 6-6" /></svg>
);

export const IconFolder = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

export const IconFileText = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />
  </svg>
);

export const IconFile = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </svg>
);

export const IconSearch = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
  </svg>
);

export const IconPlus = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}><path d="M5 12h14" /><path d="M12 5v14" /></svg>
);

export const IconFolderPlus = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M12 10v6" /><path d="M9 13h6" />
  </svg>
);

export const IconCalendarPlus = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M8 2v4" /><path d="M16 2v4" />
    <rect width="18" height="18" x="3" y="4" rx="2" />
    <path d="M3 10h18" /><path d="M12 13v5" /><path d="M9.5 15.5h5" />
  </svg>
);

export const IconSettings = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconSave = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
    <path d="M7 3v4a1 1 0 0 0 1 1h7" />
  </svg>
);

export const IconPanelLeft = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" />
  </svg>
);

export const IconPanelRight = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" />
  </svg>
);

export const IconCalendar = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M8 2v4" /><path d="M16 2v4" />
    <rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" />
  </svg>
);

export const IconListTree = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M3 6h8" /><path d="M3 12h5" /><path d="M3 18h5" />
    <path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" />
  </svg>
);

export const IconChart = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M7 16v-5" /><path d="M12 16V8" /><path d="M17 16v-8" />
  </svg>
);

export const IconRefresh = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" /><path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" /><path d="M3 21v-5h5" />
  </svg>
);

export const IconSparkles = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
  </svg>
);

export const IconX = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);

export const IconCheck = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}><path d="M20 6 9 17l-5-5" /></svg>
);

export const IconEye = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconCode = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></svg>
);

export const IconMinus = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}><path d="M5 12h14" /></svg>
);

export const IconSquare = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}><rect width="13" height="13" x="5.5" y="5.5" rx="1.5" /></svg>
);

export const IconCopy = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <rect width="12" height="12" x="8.5" y="8.5" rx="1.5" />
    <path d="M5 15.5A1.5 1.5 0 0 1 3.5 14V5A1.5 1.5 0 0 1 5 3.5h9A1.5 1.5 0 0 1 15.5 5" />
  </svg>
);

export const IconStar = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M11.53 3.05a.53.53 0 0 1 .94 0l2.31 4.68a.53.53 0 0 0 .4.29l5.16.75a.53.53 0 0 1 .3.9l-3.74 3.65a.53.53 0 0 0-.15.46l.88 5.14a.53.53 0 0 1-.76.56l-4.62-2.43a.53.53 0 0 0-.5 0l-4.62 2.43a.53.53 0 0 1-.76-.56l.88-5.14a.53.53 0 0 0-.15-.46L3.36 9.67a.53.53 0 0 1 .3-.9l5.16-.75a.53.53 0 0 0 .4-.29Z" />
  </svg>
);

export const IconClock = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);

export const IconLibrary = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M4 20h16" /><path d="M6 20V9" /><path d="M11 20V9" /><path d="M16 20V9" />
    <path d="m4 9 8-5.5L20 9Z" />
  </svg>
);

export const IconFocus = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <rect width="18" height="18" x="3" y="3" rx="3" />
    <path d="M9 3v4" /><path d="M15 3v4" /><path d="M9 17v4" /><path d="M15 17v4" />
    <path d="M3 9h4" /><path d="M3 15h4" /><path d="M17 9h4" /><path d="M17 15h4" />
  </svg>
);
