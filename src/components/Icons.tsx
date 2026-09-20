/** Line icons, 24×24, inherited stroke. Small set, used consistently. */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const IconPlane = (p: P) => (
  <svg {...base} {...p}><path d="M10.5 3.5a1.5 1.5 0 0 1 3 0V9l7.5 4.2v2.1L13.5 13v4.3l2.4 1.7v1.6L12 19.5l-3.9 1.1v-1.6l2.4-1.7V13L3 15.3v-2.1L10.5 9z" /></svg>
);

export const IconHome = (p: P) => (
  <svg {...base} {...p}><path d="M3.5 10.5 12 3.5l8.5 7" /><path d="M5.5 9.5V20h13V9.5" /><path d="M9.5 20v-5.5h5V20" /></svg>
);

export const IconUsers = (p: P) => (
  <svg {...base} {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.9" /><path d="M17.5 14.9c1.9.6 3.2 2.3 3.2 4.6" /></svg>
);

export const IconTarget = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></svg>
);

export const IconBell = (p: P) => (
  <svg {...base} {...p}><path d="M6.5 10a5.5 5.5 0 1 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10Z" /><path d="M10 18.5a2.2 2.2 0 0 0 4 0" /></svg>
);

export const IconTools = (p: P) => (
  <svg {...base} {...p}><path d="M14.5 6.2a3.8 3.8 0 0 0 5 5L15 15.7l-3-3z" /><path d="m12 12.7-6.6 6.6a1.9 1.9 0 0 1-2.7-2.7L9.3 10" /></svg>
);

export const IconSearch = (p: P) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
);

export const IconPlus = (p: P) => (
  <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>
);

export const IconUpload = (p: P) => (
  <svg {...base} {...p}><path d="M12 16V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>
);

export const IconDownload = (p: P) => (
  <svg {...base} {...p}><path d="M12 4v12" /><path d="m7.5 11.5 4.5 4.5 4.5-4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>
);

export const IconMail = (p: P) => (
  <svg {...base} {...p}><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="m3.6 7 8.4 6 8.4-6" /></svg>
);

export const IconPhone = (p: P) => (
  <svg {...base} {...p}><path d="M7 3.5 9.5 4l1.2 3.4-2 1.6a11 11 0 0 0 5.3 5.3l1.6-2 3.4 1.2.5 2.5a1.6 1.6 0 0 1-1.6 1.9A15.5 15.5 0 0 1 5.1 5.1 1.6 1.6 0 0 1 7 3.5Z" /></svg>
);

export const IconNote = (p: P) => (
  <svg {...base} {...p}><path d="M5 4.5h11l3 3V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19z" /><path d="M8.5 11h7M8.5 14.5h5" /></svg>
);

export const IconCalendar = (p: P) => (
  <svg {...base} {...p}><rect x="3.5" y="5.5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3.5v4M16 3.5v4" /></svg>
);

export const IconClock = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
);

export const IconChevronRight = (p: P) => (
  <svg {...base} {...p}><path d="m9.5 5.5 6.5 6.5-6.5 6.5" /></svg>
);

export const IconChevronLeft = (p: P) => (
  <svg {...base} {...p}><path d="M14.5 5.5 8 12l6.5 6.5" /></svg>
);

export const IconX = (p: P) => (
  <svg {...base} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>
);

export const IconCheck = (p: P) => (
  <svg {...base} {...p}><path d="m5 12.5 4.5 4.5L19 7" /></svg>
);

export const IconExternal = (p: P) => (
  <svg {...base} {...p}><path d="M14 4.5h5.5V10" /><path d="M19.5 4.5 11 13" /><path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h5" /></svg>
);

export const IconAlert = (p: P) => (
  <svg {...base} {...p}><path d="M12 4.5 21 19.5H3z" /><path d="M12 10v4M12 16.8v.2" /></svg>
);

export const IconInfo = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.2" /></svg>
);

export const IconDoc = (p: P) => (
  <svg {...base} {...p}><path d="M6 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z" /><path d="M14 3.5v4h4" /></svg>
);

export const IconMap = (p: P) => (
  <svg {...base} {...p}><path d="M9 5 3.5 7v12L9 17l6 2 5.5-2V5L15 7z" /><path d="M9 5v12M15 7v12" /></svg>
);

export const IconSettings = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" /></svg>
);

export const IconBriefcase = (p: P) => (
  <svg {...base} {...p}><rect x="3" y="7.5" width="18" height="12" rx="2" /><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5" /><path d="M3 12h18" /></svg>
);

export const IconShield = (p: P) => (
  <svg {...base} {...p}><path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.4-7 9-4.1-1.6-7-4.7-7-9V6z" /></svg>
);

export const IconTrash = (p: P) => (
  <svg {...base} {...p}><path d="M4.5 6.5h15M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" /><path d="M6.5 6.5 7.5 20a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13.5" /></svg>
);

export const IconEdit = (p: P) => (
  <svg {...base} {...p}><path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L4.5 17.5z" /><path d="m14.5 6.5 3 3" /></svg>
);

export const IconCopy = (p: P) => (
  <svg {...base} {...p}><rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2" /></svg>
);

export const IconFilter = (p: P) => (
  <svg {...base} {...p}><path d="M4 6h16l-6 7v5l-4 2v-7z" /></svg>
);

export const IconCoffee = (p: P) => (
  <svg {...base} {...p}><path d="M4.5 8.5h12V15a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z" /><path d="M16.5 10h1.5a2.5 2.5 0 0 1 0 5h-1.5" /><path d="M7 3v2M11 3v2" /></svg>
);
