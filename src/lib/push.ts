// This phone's side of notifications: asking permission, telling the server
// which device this is, and showing what arrives. The app never sends a push
// to anyone. Who is notified, about what, and when is decided and sent
// server-side (see supabase/migrations/*_notifications.sql).
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { actions } from '@/lib/api';

const TOKEN_KEY = 'opening-night.push-token';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const CAN_PUSH = Device.isDevice && (Platform.OS === 'ios' || Platform.OS === 'android');

/**
 * Where this phone stands on notifications:
 *   granted      on
 *   ask          never asked; the system prompt can still be shown
 *   denied       turned down; only Settings can turn them on now
 *   unsupported  a browser or a simulator
 */
export type PushState = 'granted' | 'ask' | 'denied' | 'unsupported';

export async function pushState(): Promise<PushState> {
  if (!CAN_PUSH) return 'unsupported';
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.status === 'granted') return 'granted';
    return permission.canAskAgain ? 'ask' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/**
 * Registers this device for the signed-in member. Best effort: a simulator,
 * a declined permission, or a missing project id simply means no pushes, and
 * the in-app inbox still works.
 *
 * The system's permission prompt is shown only with `ask`: the welcome tour
 * and You explain what notifications are for first, and ask then. Without
 * it, a phone that already said yes is registered and nothing is asked.
 */
export async function registerThisDevice(options: { ask?: boolean } = {}): Promise<void> {
  if (!CAN_PUSH) return;
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted' && options.ask) status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Movie night',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
      // Reserved for the few things that should interrupt (seat assignments, later).
      await Notifications.setNotificationChannelAsync('urgent', {
        name: 'Urgent',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
    await actions.registerPushDevice(token, Platform.OS);
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Push is never allowed to get in the way of using the app.
  }
}

/** Before signing out: this phone stops receiving the member's notifications. */
export async function unregisterThisDevice(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    await actions.unregisterPushDevice(token);
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // Signing out must still work offline.
  }
}

/** The event a tapped notification is about, if any. */
export function eventIdOf(response: Notifications.NotificationResponse): string | null {
  const id = response.notification.request.content.data?.event_id;
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
