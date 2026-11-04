/**
 * Appearance preference — "System", "Light", or "Dark".
 *
 * The system setting is the default and the honest one: someone who keeps
 * their phone permanently in dark mode means it, and a movie app is not
 * special enough to override that. But the marquee palette is a big part of
 * this app's character, so the choice is offered explicitly in You rather
 * than inferred from the clock — nobody gets flashbanged at 2pm because the
 * sun happens to be up.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useColorScheme } from '@/hooks/use-color-scheme';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedScheme = 'light' | 'dark';

const STORAGE_KEY = 'opening-night:appearance';

export const THEME_OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: 'phone-portrait-outline' },
  { value: 'light', label: 'Light', icon: 'sunny-outline' },
  { value: 'dark', label: 'Dark', icon: 'moon-outline' },
];

type ThemePreferenceValue = {
  /** What the user picked. */
  preference: ThemePreference;
  /** What that actually resolves to right now, after consulting the system. */
  scheme: ResolvedScheme;
  setPreference: (next: ThemePreference) => void;
  /** False until the stored preference has been read back off disk. */
  ready: boolean;
};

const ThemePreferenceContext = createContext<ThemePreferenceValue>({
  preference: 'system',
  scheme: 'light',
  setPreference: () => {},
  ready: false,
});

function isPreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function ThemePreferenceProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [ready, setReady] = useState(false);

  // Read the stored choice once on mount. A failure here is not worth blocking
  // the app over — it just means this launch uses the system setting.
  useEffect(() => {
    let cancelled = false;

    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (isPreference(stored)) setPreferenceState(stored);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<ThemePreferenceValue>(() => {
    // useColorScheme can return null/undefined before the scheme resolves.
    const resolvedSystem: ResolvedScheme = systemScheme === 'dark' ? 'dark' : 'light';

    return {
      preference,
      scheme: preference === 'system' ? resolvedSystem : preference,
      ready,
      setPreference: (next) => {
        // Applied immediately; the write is fire-and-forget so the tap never
        // waits on disk.
        setPreferenceState(next);
        AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      },
    };
  }, [preference, systemScheme, ready]);

  return (
    <ThemePreferenceContext.Provider value={value}>{children}</ThemePreferenceContext.Provider>
  );
}

export function useThemePreference() {
  return useContext(ThemePreferenceContext);
}
