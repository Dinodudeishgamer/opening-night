import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import { Tabs } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform, StyleSheet } from 'react-native';

import { Font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSession } from '@/lib/session';
import { getUnread, refreshUnread, subscribeUnread } from '@/lib/unread';

type IconName = keyof typeof Ionicons.glyphMap;

const icon = (active: IconName, idle: IconName) =>
  function TabIcon({ focused, color }: { focused: boolean; color: string }) {
    return <Ionicons name={focused ? active : idle} size={22} color={color} />;
  };

// What's coming, what's been, what you've been told, and you. Dino gets one more:
// Manage, for the club itself (members, invites, where money goes). Controls
// for a particular movie night live on that night's page, not here.
export default function TabsLayout() {
  const theme = useTheme();
  const { isOwner, status } = useSession();
  const unread = useSyncExternalStore(subscribeUnread, getUnread, getUnread);
  const signedIn = status === 'member';

  // The Inbox badge: counted when the app opens or comes back to the front,
  // and again whenever a push lands while it is open.
  useEffect(() => {
    if (!signedIn) return;
    void refreshUnread();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshUnread();
    });
    const received = Platform.OS === 'web' ? null : Notifications.addNotificationReceivedListener(() => void refreshUnread());
    return () => {
      appState.remove();
      received?.remove();
    };
  }, [signedIn]);

  // Nothing behind the door is drawn, or asks the server for anything, until
  // someone is signed in. The root layout is already sending them to sign-in.
  if (!signedIn) return null;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textSecondary,
        // No explicit height: react-navigation sizes the bar and applies the
        // bottom safe-area inset itself; hardcoded math clipped the labels.
        tabBarStyle: {
          backgroundColor: theme.backgroundElement,
          borderTopColor: theme.border,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        // Sized so the longest label, "Coming Soon", fits under its icon even
        // with Dino's five tabs, and held at that size: a label that grew with
        // the phone's text-size setting would be cut off again.
        tabBarLabelStyle: { fontSize: 10, lineHeight: 14, fontFamily: Font.semibold, letterSpacing: 0 },
        tabBarAllowFontScaling: false,
      }}>
      <Tabs.Screen name="index" options={{ title: 'Coming Soon', tabBarIcon: icon('film', 'film-outline') }} />
      <Tabs.Screen name="past" options={{ title: 'Past', tabBarIcon: icon('play-back', 'play-back-outline') }} />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          tabBarIcon: icon('notifications', 'notifications-outline'),
          tabBarBadge: unread > 0 ? (unread > 9 ? '9+' : unread) : undefined,
          tabBarBadgeStyle: { backgroundColor: theme.accent, color: theme.onAccent, fontFamily: Font.bold, fontSize: 11 },
        }}
      />
      {/* Hidden for members. The screen itself shows nothing useful to them either,
          and every action behind it is refused by the database for anyone but Dino. */}
      <Tabs.Screen
        name="manage"
        options={{ title: 'Manage', href: isOwner ? undefined : null, tabBarIcon: icon('construct', 'construct-outline') }}
      />
      <Tabs.Screen name="you" options={{ title: 'You', tabBarIcon: icon('person-circle', 'person-circle-outline') }} />
    </Tabs>
  );
}
