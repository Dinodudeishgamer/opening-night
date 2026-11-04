// The welcome tour: the first thing a member sees after signing in on a
// phone. Four pages, swiped or stepped through:
//
//   hello          who this is for, and a word from Dino (his video)
//   how it works   the five things a movie night asks of you
//   your picture   so the roster is faces, not grey circles
//   notifications  why to turn them on, asked before iOS asks
//
// Every page can be skipped, and the tour can be watched again from You.
// Nothing here is required to use the app.
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Linking, type NativeScrollEvent, type NativeSyntheticEvent, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AvatarPicker } from '@/components/avatar-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { INTRO_VIDEO_URL } from '@/constants/intro';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { haptic } from '@/lib/haptics';
import { markIntroSeen } from '@/lib/intro';
import { type PushState, pushState, registerThisDevice } from '@/lib/push';
import { useSession } from '@/lib/session';

const GOLD = '#F2B84B';

const STEPS: { icon: keyof typeof Ionicons.glyphMap; title: string; text: string }[] = [
  { icon: 'hand-left', title: 'Say if you are in', text: 'Dino posts a movie. Going, Maybe, or Can’t Go. Bring a guest if you like.' },
  { icon: 'checkbox', title: 'Tick the showtimes that work', text: 'Every one you could make. Dino picks the one that suits the most people.' },
  { icon: 'ticket', title: 'Confirm, and pay Dino back', text: 'He buys the tickets for everyone who confirmed. Venmo, Apple Cash, or cash on the night.' },
  { icon: 'sparkles', title: 'Guess your rating', text: 'Before the lights go down, lock in a score out of 5. No changing it.' },
  { icon: 'star', title: 'Rate it afterwards', text: 'Then see how the whole group scored it, and who called it.' },
];

export default function IntroScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { me } = useSession();
  const { replay } = useLocalSearchParams<{ replay?: string }>();
  const { width } = useWindowDimensions();
  const pager = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const [push, setPush] = useState<PushState>('unsupported');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    void pushState().then(setPush);
  }, []);

  if (!me) return null;
  const pages = 4;
  const last = page === pages - 1;

  function go(to: number) {
    haptic.tick();
    pager.current?.scrollTo({ x: to * width, animated: true });
    setPage(to);
  }

  function onScrollEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    setPage(Math.round(event.nativeEvent.contentOffset.x / Math.max(width, 1)));
  }

  async function finish() {
    await markIntroSeen(me!.member_id);
    // Watching it again from You goes back there; the first time, on to the app.
    if (replay && router.canGoBack()) router.back();
    else router.replace('/(tabs)' as Href);
  }

  async function turnOn() {
    if (push === 'denied') {
      // iOS only ever asks once. After a no, the switch lives in Settings.
      void Linking.openSettings();
      return;
    }
    setAsking(true);
    await registerThisDevice({ ask: true });
    setAsking(false);
    haptic.success();
    void finish();
  }

  return (
    <ThemedView type="background" style={styles.fill}>
      <SafeAreaView style={styles.fill} edges={['top', 'bottom']}>
        <View style={styles.top}>
          <View style={styles.dots} accessibilityLabel={`Page ${page + 1} of ${pages}`}>
            {Array.from({ length: pages }, (_, index) => (
              <View key={index} style={[styles.dot, { backgroundColor: index === page ? theme.accent : theme.border, width: index === page ? 22 : 8 }]} />
            ))}
          </View>
          <Pressable onPress={() => void finish()} hitSlop={12} accessibilityRole="button">
            <ThemedText type="smallBold" themeColor="textSecondary">
              {replay ? 'Close' : 'Skip'}
            </ThemedText>
          </Pressable>
        </View>

        <ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onScrollEnd}
          keyboardShouldPersistTaps="handled"
          style={styles.fill}>
          <Page width={width}>
            <Bulbs />
            <ThemedText type="eyebrow" style={{ color: theme.accent }}>
              Now showing
            </ThemedText>
            <ThemedText style={styles.title}>Welcome, {me.first_name}</ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.lead}>
              Opening Night is how our movie nights get planned: who is in, which showtime, who called the rating. Just us, by invitation.
            </ThemedText>
            <IntroVideo />
          </Page>

          <Page width={width}>
            <ThemedText type="eyebrow" style={{ color: theme.accent }}>
              How it works
            </ThemedText>
            <ThemedText style={styles.title}>One movie night, five small things</ThemedText>
            <View style={styles.steps}>
              {STEPS.map((step, index) => (
                <View key={step.title} style={styles.step}>
                  <View style={styles.stepRail}>
                    <View style={[styles.stepIcon, { backgroundColor: theme.accent }]}>
                      <Ionicons name={step.icon} size={18} color={theme.onAccent} />
                    </View>
                    {index < STEPS.length - 1 && <View style={[styles.stepLine, { backgroundColor: theme.border }]} />}
                  </View>
                  <View style={styles.stepText}>
                    <ThemedText style={styles.stepTitle}>{step.title}</ThemedText>
                    <ThemedText themeColor="textSecondary" style={styles.stepBody}>
                      {step.text}
                    </ThemedText>
                  </View>
                </View>
              ))}
            </View>
            <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
              The app tells you when it is your turn. Anything waiting on you sits at the top of Coming Soon.
            </ThemedText>
          </Page>

          <Page width={width}>
            <ThemedText type="eyebrow" style={{ color: theme.accent }}>
              Your picture
            </ThemedText>
            <ThemedText style={styles.title}>Pick a face</ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.lead}>
              It shows next to your name on every movie night. Change it any time from You.
            </ThemedText>
            <View style={styles.stretch}>
              <AvatarPicker previewSize={104} />
            </View>
          </Page>

          <Page width={width}>
            <View style={[styles.bell, { backgroundColor: theme.backgroundSelected, borderColor: theme.accent }]}>
              <Ionicons name={push === 'granted' ? 'notifications' : 'notifications-outline'} size={44} color={theme.accent} />
            </View>
            <ThemedText type="eyebrow" style={{ color: theme.accent }}>
              Notifications
            </ThemedText>
            <ThemedText style={styles.title}>{push === 'granted' ? 'You are all set' : 'Do not miss the vote'}</ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.lead}>
              {push === 'unsupported'
                ? 'Notifications work in the app on your phone. Here, the Inbox tab keeps everything you would have been sent.'
                : 'A new movie night, the showtime Dino picked, a nudge before a deadline. That is all of it.'}
            </ThemedText>
            {push !== 'unsupported' && (
              <View style={styles.promises}>
                <Pledge icon="checkmark-done-outline" text="They stop the moment you have answered." />
                <Pledge icon="mail-outline" text="Everything is also kept in your Inbox tab." />
              </View>
            )}
          </Page>
        </ScrollView>

        <View style={styles.foot}>
          {!last ? (
            <Button title="Next" onPress={() => go(page + 1)} />
          ) : push === 'granted' || push === 'unsupported' ? (
            <Button title={replay ? 'Done' : 'Take me in'} icon="film-outline" onPress={() => void finish()} />
          ) : (
            <>
              <Button
                title={push === 'denied' ? 'Open Settings to turn them on' : 'Turn on notifications'}
                icon="notifications-outline"
                loading={asking}
                onPress={() => void turnOn()}
              />
              <Button title="Not now" variant="secondary" onPress={() => void finish()} />
            </>
          )}
        </View>
      </SafeAreaView>
    </ThemedView>
  );
}

function Page({ width, children }: { width: number; children: ReactNode }) {
  return (
    <ScrollView style={{ width }} contentContainerStyle={styles.page} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

function Pledge({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  const theme = useTheme();
  return (
    <View style={styles.promise}>
      <Ionicons name={icon} size={18} color={theme.accent} />
      <ThemedText style={styles.promiseText}>{text}</ThemedText>
    </View>
  );
}

/** A row of marquee lights, as on the sign-in screen. */
function Bulbs() {
  return (
    <View style={styles.bulbs} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: 13 }, (_, index) => (
        <View key={index} style={[styles.bulb, index % 2 === 1 && styles.bulbDim]} />
      ))}
    </View>
  );
}

/** Dino's video, or the card that holds its place until he has made it. */
function IntroVideo() {
  if (INTRO_VIDEO_URL) return <Player url={INTRO_VIDEO_URL} />;
  return (
    <View style={styles.video}>
      <LinearGradient colors={['#2A2312', '#0C0D10']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={styles.play}>
        <Ionicons name="play" size={26} color="#1A1300" style={styles.playGlyph} />
      </View>
      <ThemedText style={styles.videoTitle}>A word from Dino</ThemedText>
      <ThemedText style={styles.videoNote}>Video coming soon</ThemedText>
    </View>
  );
}

function Player({ url }: { url: string }) {
  const player = useVideoPlayer(url, (created) => {
    created.loop = false;
  });
  return (
    <View style={styles.video}>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls allowsFullscreen />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { textAlign: 'center' },
  stretch: { alignSelf: 'stretch' },

  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.four, paddingVertical: Spacing.three },
  dots: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  dot: { height: 8, borderRadius: 4 },

  page: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', gap: Spacing.three, paddingHorizontal: Spacing.four, paddingVertical: Spacing.three },
  title: { fontFamily: Font.serifBold, fontSize: 34, lineHeight: 40, letterSpacing: -0.6, textAlign: 'center' },
  lead: { fontSize: 16, lineHeight: 24, textAlign: 'center' },

  bulbs: { flexDirection: 'row', gap: 10, marginBottom: Spacing.two },
  bulb: { width: 8, height: 8, borderRadius: 4, backgroundColor: GOLD },
  bulbDim: { opacity: 0.35 },

  video: { alignSelf: 'stretch', aspectRatio: 16 / 9, borderRadius: Radius.lg, borderWidth: 1, borderColor: 'rgba(242,184,75,0.45)', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', gap: Spacing.one, backgroundColor: '#0C0D10', marginTop: Spacing.two },
  play: { width: 60, height: 60, borderRadius: 30, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.one },
  playGlyph: { marginLeft: 4 },
  videoTitle: { fontFamily: Font.serifBold, fontSize: 20, lineHeight: 26, color: '#FFFFFF' },
  videoNote: { fontFamily: Font.bold, fontSize: 11, lineHeight: 15, letterSpacing: 1.6, textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)' },

  steps: { alignSelf: 'stretch', marginTop: Spacing.one },
  step: { flexDirection: 'row', gap: Spacing.three },
  stepRail: { alignItems: 'center' },
  stepIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  stepLine: { width: 2, flex: 1, minHeight: 12, marginVertical: 3, borderRadius: 1 },
  stepText: { flex: 1, paddingBottom: Spacing.three, gap: 2 },
  stepTitle: { fontFamily: Font.bold, fontSize: 16, lineHeight: 22, marginTop: 6 },
  stepBody: { fontSize: 14, lineHeight: 21 },

  bell: { width: 96, height: 96, borderRadius: 48, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.two },
  promises: { alignSelf: 'stretch', gap: Spacing.two + 4, marginTop: Spacing.two },
  promise: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  promiseText: { flex: 1, fontFamily: Font.medium, fontSize: 15, lineHeight: 21 },

  foot: { gap: Spacing.two, paddingHorizontal: Spacing.four, paddingTop: Spacing.two, paddingBottom: Spacing.two },
});
