// Dino's Cinemark rewards card. Everyone buys tickets and snacks with his
// member QR, so the points pool on one account and come back to the club as
// perks. It used to be a screenshot in the group chat; now it is here, big and
// bright on a dark card, ready to hold up to the scanner.
//
// The picture lives in app_settings (members only), not in the app itself.
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { BackHeader } from '@/components/ui/back-header';
import { EmptyState } from '@/components/ui/empty-state';
import { RefreshScreen } from '@/components/ui/refresh-screen';
import { Font, Radius, Spacing } from '@/constants/theme';
import { getSettings } from '@/lib/api';
import type { AppSettings } from '@/lib/types';

const GOLD = '#F2B84B';
const INK = '#0A0A0C';
const BULBS = 15;

export default function RewardsScreen() {
  const { width } = useWindowDimensions();
  const [settings, setSettings] = useState<AppSettings | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setSettings(await getSettings());
    } catch {
      setSettings((current) => current ?? null);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // As big as the phone allows, with the card's own padding around it.
  const size = Math.min(width - Spacing.four * 2 - Spacing.four * 2, 340);

  return (
    <RefreshScreen onRefresh={load} edges={['top', 'bottom', 'left', 'right']}>
      <BackHeader title="Rewards" />
      {settings === undefined ? null : !settings?.rewards_qr ? (
        <EmptyState icon="🎟️" title="No rewards card yet" subtitle="Dino has not added his Cinemark QR code to the app yet." />
      ) : (
        <View style={styles.card}>
          <Bulbs />
          <Text style={styles.brand}>{settings.rewards_label ?? 'Cinemark Movie Rewards'}</Text>
          <Text style={styles.title}>{"Dino's card"}</Text>
          <View style={styles.qrFrame}>
            <Image
              source={{ uri: settings.rewards_qr }}
              style={{ width: size, height: size }}
              contentFit="contain"
              accessibilityLabel="Dino's Cinemark rewards QR code"
            />
          </View>
          <Text style={styles.how}>Scan this when you buy tickets or snacks at Cinemark.</Text>
          <Text style={styles.why}>{"The points go to Dino's account, and the perks come back to the whole club."}</Text>
          <Text style={styles.tip}>Not scanning? Turn your screen brightness all the way up.</Text>
          <Bulbs />
        </View>
      )}
    </RefreshScreen>
  );
}

function Bulbs() {
  return (
    <View style={styles.bulbs}>
      {Array.from({ length: BULBS }, (_, index) => (
        <View key={index} style={[styles.bulb, index % 2 === 1 && styles.bulbDim]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(242,184,75,0.45)',
    backgroundColor: INK,
    padding: Spacing.four,
    gap: Spacing.two,
    alignItems: 'center',
  },
  bulbs: { flexDirection: 'row', justifyContent: 'space-between', alignSelf: 'stretch' },
  bulb: { width: 6, height: 6, borderRadius: 3, backgroundColor: GOLD },
  bulbDim: { opacity: 0.35 },
  brand: { fontFamily: Font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 3, textTransform: 'uppercase', color: GOLD, textAlign: 'center', marginTop: Spacing.one },
  title: { fontFamily: Font.serifBold, fontSize: 30, lineHeight: 36, letterSpacing: -0.4, color: '#FFFFFF', textAlign: 'center' },
  // The QR needs a white surround to scan; the picture brings its own quiet zone.
  qrFrame: { backgroundColor: '#FFFFFF', borderRadius: Radius.md, padding: Spacing.two, marginVertical: Spacing.two },
  how: { fontFamily: Font.bold, fontSize: 16, lineHeight: 22, color: '#FFFFFF', textAlign: 'center' },
  why: { fontFamily: Font.regular, fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.75)', textAlign: 'center' },
  tip: { fontFamily: Font.regular, fontSize: 12, lineHeight: 17, color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: Spacing.one },
});
