/**
 * Confirmations and alerts that work on both targets.
 *
 * React Native's `Alert` has no web implementation, and every call site had
 * quietly grown the same workaround: `if (Platform.OS === 'web') justDoIt()`.
 * That turned "Delete this event?" into an unconfirmed, irreversible tap on the
 * web build. These two helpers keep the native dialog and fall back to the
 * browser's own, so a destructive action is never silently un-guarded.
 */

import { Alert, Platform, Share } from 'react-native';

type ConfirmOptions = {
  title: string;
  message: string;
  /** Text on the confirming button. Defaults to "OK". */
  confirmLabel?: string;
  /** Red-tints the confirming button on iOS. */
  destructive?: boolean;
  onConfirm: () => void;
};

export function confirmAction({
  title,
  message,
  confirmLabel = 'OK',
  destructive = false,
  onConfirm,
}: ConfirmOptions) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }

  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
  ]);
}

/**
 * Hands a piece of text to the share sheet. A desktop browser has no share
 * sheet, so there it goes to the clipboard and says so.
 */
export async function shareText(message: string): Promise<void> {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.share) {
    try {
      await navigator.clipboard.writeText(message);
      showAlert('Copied', 'Paste it into a message.');
    } catch {
      showAlert('Could not copy', 'Select the code and copy it by hand.');
    }
    return;
  }
  try {
    await Share.share({ message });
  } catch {
    // Closing the share sheet without choosing anything is not an error.
  }
}

/** Tell the user something they can only acknowledge. */
export function showAlert(title: string, message: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}
