/**
 * The active palette. Reads the resolved scheme from the appearance
 * preference (see lib/theme-preference.tsx) rather than the system setting
 * directly, so a manual Light/Dark choice in You wins everywhere at once.
 */

import { Colors } from '@/constants/theme';
import { useThemePreference } from '@/lib/theme-preference';

export function useTheme() {
  const { scheme } = useThemePreference();
  return Colors[scheme];
}
