// Whether this phone has shown the welcome tour to the member signed in on
// it. Remembered on the phone only, per member: a new phone (or a new member
// on this one) gets the tour again, which is right, since it is also where
// notifications are turned on.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

const key = (memberId: string) => `opening-night.intro-seen.${memberId}`;

const seen = new Map<string, boolean>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function load(memberId: string) {
  if (seen.has(memberId)) return;
  let value = false;
  try {
    value = (await AsyncStorage.getItem(key(memberId))) === '1';
  } catch {
    // Unreadable storage: show the tour rather than guess.
  }
  if (!seen.has(memberId)) {
    seen.set(memberId, value);
    changed();
  }
}

/** The tour is done (or skipped) for this member on this phone. */
export async function markIntroSeen(memberId: string): Promise<void> {
  seen.set(memberId, true);
  changed();
  try {
    await AsyncStorage.setItem(key(memberId), '1');
  } catch {
    // It will be offered once more next launch; nothing worse.
  }
}

/** `undefined` while the answer is still coming off disk, or nobody is signed in. */
export function useIntroSeen(memberId: string | null | undefined): boolean | undefined {
  useEffect(() => {
    if (memberId) void load(memberId);
  }, [memberId]);
  const read = () => (memberId ? seen.get(memberId) : undefined);
  return useSyncExternalStore(subscribe, read, read);
}
