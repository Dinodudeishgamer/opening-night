// The moment after you rate: the lights come up and the group's score rolls
// onto the screen, with how your own guess held up. Shown once, right after
// a first rating goes in; the same numbers live on in "So far" below.
//
// Always dark, whatever the app's appearance: it is the one screen that is a
// cinema, not a page.
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { EventCtx } from '@/components/event/context';
import { eventTitle } from '@/components/event-card';
import { Font, Radius, Spacing } from '@/constants/theme';
import { MAX_SCORE, score, tmdbImage } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { verdict } from '@/lib/stats';

const GOLD = '#F2B84B';
const ROLL_MS = 1700;

export function RevealModal({ ctx, visible, onClose }: { ctx: EventCtx; visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { event } = ctx.bundle;
  const [shown, setShown] = useState(0);
  const [landed, setLanded] = useState(false);
  const rest = useRef(new Animated.Value(0)).current;

  const rated = ctx.people.filter((person) => person.participant.checked_in_at && person.rating !== undefined);
  const average = rated.length ? rated.reduce((sum, person) => sum + person.rating!, 0) / rated.length : 0;
  const self = ctx.people.find((person) => person.isMe);
  const mine = self?.rating;
  const guess = self?.predictionActive === false ? undefined : self?.prediction;
  const change = mine !== undefined && guess !== undefined ? Math.round((mine - guess) * 100) / 100 : null;
  const art = tmdbImage(event.poster_path ?? event.movie.poster_path, 'w500');

  // Roll the number up from zero, ticking as each half point goes by, then land.
  useEffect(() => {
    if (!visible) return;
    setShown(0);
    setLanded(false);
    rest.setValue(0);
    const started = Date.now();
    let frame = 0;
    let lastHalf = 0;
    const step = () => {
      const t = Math.min(1, (Date.now() - started) / ROLL_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = average * eased;
      if (Math.floor(value * 2) !== lastHalf) {
        lastHalf = Math.floor(value * 2);
        haptic.tick();
      }
      setShown(value);
      if (t < 1) {
        frame = requestAnimationFrame(step);
      } else {
        setLanded(true);
        haptic.thud();
        Animated.timing(rest, { toValue: 1, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [visible, average, rest]);

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent presentationStyle="fullScreen">
      <StatusBar style="light" />
      <View style={styles.stage}>
        {art && <Image source={{ uri: art }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} />}
        <LinearGradient colors={['rgba(8,8,10,0.72)', 'rgba(8,8,10,0.9)', '#08080A']} locations={[0, 0.55, 1]} style={StyleSheet.absoluteFill} />

        <View style={[styles.body, { paddingTop: insets.top + Spacing.five, paddingBottom: Math.max(insets.bottom, Spacing.three) + Spacing.two }]}>
          <View style={styles.head}>
            <Text style={styles.eyebrow}>{rated.length > 1 ? 'The verdict so far' : 'First one in'}</Text>
            <Text style={styles.movie} numberOfLines={2}>
              {eventTitle(event)}
            </Text>
          </View>

          <View style={styles.center}>
            <Text style={[styles.number, landed && styles.numberLanded]} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={`Group rating ${score(average)} out of ${MAX_SCORE}`}>
              {score(shown)}
            </Text>
            <Text style={styles.unit}>{rated.length > 1 ? `Group rating · ${rated.length} in` : 'Your rating'}</Text>

            <Animated.View style={[styles.after, { opacity: rest, transform: [{ translateY: rest.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }]}>
              {change !== null && (
                <>
                  <Text style={styles.verdict}>{verdict(change)}</Text>
                  <View style={styles.mine}>
                    <Stat label="You guessed" value={score(guess!)} />
                    <View style={styles.arrow}>
                      <Text style={[styles.change, { color: change > 0 ? '#6FCF73' : change < 0 ? '#F0766D' : 'rgba(255,255,255,0.7)' }]}>
                        {change > 0 ? '+' : ''}
                        {change.toFixed(2)}
                      </Text>
                    </View>
                    <Stat label="You rated" value={score(mine!)} bright />
                  </View>
                </>
              )}
              <Text style={styles.note}>
                {rated.length > 1
                  ? 'This moves as the others rate. You can change yours for 48 hours.'
                  : 'The group score fills in as the others rate. You can change yours for 48 hours.'}
              </Text>
            </Animated.View>
          </View>

          <Animated.View style={{ opacity: rest }}>
            <Pressable onPress={onClose} accessibilityRole="button" style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
              <Text style={styles.buttonText}>{rated.length > 1 ? "See everyone's" : 'Done'}</Text>
            </Pressable>
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

function Stat({ label, value, bright }: { label: string; value: string; bright?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, bright && { color: GOLD }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: '#08080A' },
  body: { flex: 1, paddingHorizontal: Spacing.four, justifyContent: 'space-between' },
  head: { alignItems: 'center', gap: Spacing.one },
  eyebrow: { fontFamily: Font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 2, textTransform: 'uppercase', color: GOLD },
  movie: { fontFamily: Font.serifBold, fontSize: 26, lineHeight: 32, letterSpacing: -0.4, color: '#FFFFFF', textAlign: 'center' },

  center: { alignItems: 'center', alignSelf: 'stretch' },
  number: { fontFamily: Font.serifBold, fontSize: 116, lineHeight: 130, letterSpacing: -4, alignSelf: 'stretch', textAlign: 'center', color: 'rgba(242,184,75,0.75)', fontVariant: ['tabular-nums'] },
  numberLanded: { color: GOLD },
  unit: { fontFamily: Font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.75)', marginTop: -Spacing.one },

  after: { alignItems: 'center', gap: Spacing.three, marginTop: Spacing.five, alignSelf: 'stretch' },
  verdict: { fontFamily: Font.serifBold, fontSize: 24, lineHeight: 30, color: '#FFFFFF', textAlign: 'center' },
  mine: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)', backgroundColor: 'rgba(255,255,255,0.06)', paddingVertical: Spacing.three },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statLabel: { fontFamily: Font.bold, fontSize: 10, lineHeight: 14, letterSpacing: 1.4, textTransform: 'uppercase', color: 'rgba(255,255,255,0.65)' },
  statValue: { fontFamily: Font.serifBold, fontSize: 30, lineHeight: 38, color: '#FFFFFF' },
  arrow: { alignItems: 'center', minWidth: 64 },
  change: { fontFamily: Font.extrabold, fontSize: 17, lineHeight: 24 },
  note: { fontFamily: Font.medium, fontSize: 13, lineHeight: 19, color: 'rgba(255,255,255,0.65)', textAlign: 'center' },

  button: { minHeight: 52, borderRadius: Radius.md, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontFamily: Font.bold, fontSize: 16, letterSpacing: 0.2, color: '#1A1300' },
  pressed: { opacity: 0.85 },
});
