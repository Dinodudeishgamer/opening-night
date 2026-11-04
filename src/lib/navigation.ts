import { Router } from 'expo-router';

/**
 * Leave the current screen: pop real history when there is any, otherwise land
 * on the home list. The fallback covers cold entries — a push-notification tap
 * or deep link straight onto an event page — where there's nothing to pop to.
 */
export function backOrHome(router: Router) {
  if (router.canGoBack()) router.back();
  else router.replace('/(tabs)');
}
