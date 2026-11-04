import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#1A1714',
    background: '#F4F0E6',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#F6E6C0',
    textSecondary: '#6E655B',
    // Deep "marquee" gold — passes WCAG AA (4.5:1) as text and as a button fill
    // on the ivory background, unlike the previous bright gold which read faint.
    accent: '#8A6111',
    // Bright gold reserved for large/decorative use where contrast rules relax.
    accentBright: '#C8963E',
    onAccent: '#FFFFFF',
    success: '#2E7D32',
    warning: '#9A6B12',
    danger: '#C0392B',
    border: '#E4DCCB',
    overlay: 'rgba(20, 17, 12, 0.5)',
  },
  dark: {
    text: '#F3EFE6',
    background: '#0C0D10',
    backgroundElement: '#16181D',
    backgroundSelected: '#2A2312',
    textSecondary: '#A49B8C',
    // Bright marquee gold reads beautifully — and accessibly — on near-black.
    accent: '#F2B84B',
    accentBright: '#F2B84B',
    onAccent: '#1A1300',
    success: '#4CAF50',
    warning: '#F2B84B',
    danger: '#E5544A',
    border: '#2A2D34',
    overlay: 'rgba(0, 0, 0, 0.6)',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * The app's semantic status vocabulary. Everything that reports state — badges,
 * roster rows, save confirmations, error lines — speaks in tones rather than
 * naming a colour, so "this went wrong" looks identical wherever it appears.
 */
export type Tone = 'success' | 'warning' | 'danger' | 'muted' | 'accent';

export const TONE_COLOR: Record<Tone, ThemeColor> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  muted: 'textSecondary',
  accent: 'accent',
};

/** A one-line piece of feedback and how it should read. Rendered by StatusNote. */
export type Note = { text: string; tone: Tone };

/**
 * Loaded font families (see app root `useFonts`). Reference these by exact name
 * — React Native maps a specific weight to a specific family, so we never rely
 * on synthetic `fontWeight` bolding (which looks muddy). Inter for UI, Fraunces
 * (editorial serif) for the wordmark and display headings.
 */
export const Font = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  extrabold: 'Inter_800ExtraBold',
  serifBold: 'Fraunces_700Bold',
} as const;

/**
 * The one face the app doesn't ship itself: invite codes are read aloud and
 * typed in, so they get the platform's own monospace rather than Inter.
 */
export const MONO_FONT = Platform.select({
  ios: 'ui-monospace',
  web: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  default: 'monospace',
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  full: 999,
} as const;

export const Shadow = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
  },
} as const;

