import type { ReactNode } from "react";

/** A small set of line icons, drawn for this portal.
 *
 *  Inline SVG on `currentColor`, so they follow the theme and the surrounding
 *  text colour with no image files to ship - the portal has to work inside a
 *  locked-down workspace. All share one 24px grid and stroke, so they read as
 *  a family.
 */
function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

/** A window with its side panel: fold or unfold the chat list. */
export const PanelLeftIcon = ({ size }: P) => (
  <Svg size={size}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9.5 4v16" />
  </Svg>
);

/** A page with a pencil: start a new chat. */
export const NewChatIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M11 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4" />
    <path d="M17.5 3.5a1.9 1.9 0 0 1 2.7 2.7L12 14.4 8.5 15.5l1.1-3.5z" />
  </Svg>
);

export const SearchIcon = ({ size }: P) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.9-3.9" />
  </Svg>
);

export const PaperclipIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="m20.5 11.6-8.3 8.3a5.2 5.2 0 0 1-7.4-7.4l8.6-8.6a3.5 3.5 0 0 1 5 5l-8.6 8.6a1.8 1.8 0 0 1-2.5-2.5l7.9-7.9" />
  </Svg>
);

export const ArrowUpIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 19V5" />
    <path d="m5.5 11.5 6.5-6.5 6.5 6.5" />
  </Svg>
);

export const CopyIcon = ({ size }: P) => (
  <Svg size={size}>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5 15V7a3 3 0 0 1 3-3h8" />
  </Svg>
);

export const CheckIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const RefreshIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v5h-5" />
  </Svg>
);

export const TrashIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M4 7h16" />
    <path d="M9 7V4.5h6V7" />
    <path d="M6.5 7l.8 11.5a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);

export const ChevronLeftIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="m14.5 6-6 6 6 6" />
  </Svg>
);

/** A four-point sparkle: the assistant's mark, in place of a face. */
export const SparkleIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.3l-1.9-5.5L4.5 10.9 10.1 9z" />
  </Svg>
);

export const SunIcon = ({ size }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
  </Svg>
);

export const MoonIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Svg>
);

export const MessageIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
  </Svg>
);

export const ThreadsIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M4 6h12M4 11h16M4 16h9" />
  </Svg>
);

export const UploadIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4.5 16v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V16" />
  </Svg>
);

export const DownloadIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 4v12M7 11l5 5 5-5" />
    <path d="M4.5 16v2.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V16" />
  </Svg>
);

export const ArrowUpRightIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M7 17 17 7M8 7h9v9" />
  </Svg>
);

export const ArrowDownRightIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M7 7l10 10M17 8v9H8" />
  </Svg>
);
