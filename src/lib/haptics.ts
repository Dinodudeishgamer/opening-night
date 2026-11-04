// The small taps the phone gives back under a finger. Used sparingly: when an
// answer is chosen, as a score slides, and when something is locked in.
// Never allowed to get in the way: a phone with haptics off, or a browser,
// simply feels nothing.
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

const SUPPORTED = Platform.OS === 'ios' || Platform.OS === 'android';

function quietly(work: () => Promise<void>) {
  if (!SUPPORTED) return;
  try {
    work().catch(() => {});
  } catch {
    // No haptics on this device.
  }
}

export const haptic = {
  /** An answer was picked. */
  tap: () => quietly(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** One notch of a dial or slider. */
  tick: () => quietly(() => Haptics.selectionAsync()),
  /** Something was locked in or sent. */
  success: () => quietly(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** The big number landed. */
  thud: () => quietly(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
};
