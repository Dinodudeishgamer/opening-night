import { Fraunces_700Bold } from '@expo-google-fonts/fraunces';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { type Href, Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { SplashOverlay } from '@/components/splash-overlay';
import { useIntroSeen } from '@/lib/intro';
import { eventIdOf } from '@/lib/push';
import { SessionProvider, useSession } from '@/lib/session';
import { ThemePreferenceProvider, useThemePreference } from '@/lib/theme-preference';

SplashScreen.preventAutoHideAsync();

function RootNavigation() {
  const { status, me } = useSession();
  const segments = useSegments();
  const router = useRouter();
  // Has this phone shown this member the welcome tour? Undefined while that is still being read.
  const introSeen = useIntroSeen(status === 'member' ? me?.member_id : null);

  // The one place that decides which side of the door someone is on.
  useEffect(() => {
    if (status === 'loading') return;
    const inAuth = segments[0] === '(auth)';
    const screen = segments[1] as string | undefined;
    if (status === 'signedOut' && !(inAuth && screen === 'welcome')) {
      router.replace('/(auth)/welcome' as Href);
    } else if (status === 'noMember' && !(inAuth && screen === 'no-access')) {
      router.replace('/(auth)/no-access' as Href);
    } else if (status === 'member') {
      // Straight from signing in (or the first launch after an update that added it): the tour, once.
      if (introSeen === false && segments[0] !== 'intro') router.replace('/intro' as Href);
      else if (introSeen && inAuth) router.replace('/(tabs)' as Href);
    }
  }, [status, segments, router, introSeen]);

  // A tapped notification opens the event it is about.
  useEffect(() => {
    // Notifications exist on phones only; in a browser there is nothing to tap.
    if (status !== 'member' || Platform.OS === 'web') return;
    function open(response: Notifications.NotificationResponse) {
      const eventId = eventIdOf(response);
      if (eventId) router.push(`/event/${eventId}` as Href);
    }
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) open(response);
    });
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [status, router]);

  if (status === 'loading' || (status === 'member' && introSeen === undefined)) return null;

  // A real root Stack so event pages push over the tabs with genuine history:
  // back, button or swipe, returns to the screen that opened them.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="intro" options={{ gestureEnabled: false, animation: 'fade' }} />
      <Stack.Screen name="event/[id]" />
      <Stack.Screen name="check-in/[id]" />
      <Stack.Screen name="new-event" />
    </Stack>
  );
}

/**
 * Everything below the appearance provider, so the navigation chrome and the
 * status bar follow the resolved scheme: a manual Light/Dark choice in You
 * has to move them too, not just the app's own surfaces.
 */
function ThemedApp() {
  const { scheme, ready } = useThemePreference();

  // Hold one more beat for the stored choice to come back off disk. Without
  // this, someone who picked Dark watches the app open light and snap over.
  if (!ready) return null;

  const dark = scheme === 'dark';

  return (
    <SessionProvider>
      <ThemeProvider value={dark ? DarkTheme : DefaultTheme}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        <SplashOverlay />
        <RootNavigation />
      </ThemeProvider>
    </SessionProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
    Fraunces_700Bold,
  });

  // Keep the native splash up until fonts resolve; on a font error we still
  // render (falling back to system fonts) rather than trapping the user.
  if (!fontsLoaded && !fontError) return null;

  return (
    <ThemePreferenceProvider>
      <ThemedApp />
    </ThemePreferenceProvider>
  );
}
