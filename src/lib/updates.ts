// Getting the newest version in front of people at once.
//
// By default an over-the-air update downloads in the background and only
// shows on the next launch. So a friend who had just installed the app, or
// had not opened it in a while, used an old version first: the 10-point
// scale, sections since removed. Now, while the splash screen is still up,
// the app asks whether there is a newer version; if there is, it downloads
// it and restarts into it straight away. Short time limits keep a slow
// connection from holding the app up: past them, the app opens as it is and
// the update waits for next time, as before.
import * as Updates from 'expo-updates';

const CHECK_MS = 2500;
const FETCH_MS = 12000;

function within<T>(ms: number, work: Promise<T>): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** Resolves when the app should carry on opening. Restarts the app instead if a newer version was just downloaded. */
export async function openNewestVersion(): Promise<void> {
  if (__DEV__ || !Updates.isEnabled) return;
  try {
    const check = await within(CHECK_MS, Updates.checkForUpdateAsync());
    if (!check?.isAvailable) return;
    const fetched = await within(FETCH_MS, Updates.fetchUpdateAsync());
    if (fetched?.isNew) await Updates.reloadAsync();
  } catch {
    // Offline, or the update service is down: open what is installed.
  }
}
