// Dino's Cinemark Platinum Rewards card: 25% off concessions for whoever
// shows it. It used to be a screenshot in the group chat; now it is here, big
// and bright on a dark card, ready to hold up to the scanner.
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

// The picture is 29 modules square: the 21-module code with a 4-module white
// border. Showing the middle 25 keeps a 2-module border (plenty for a
// scanner, and the white frame continues it) and makes the code itself bigger.
const MODULES = 29;
const SHOWN = 25;

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
  const size = Math.min(width - Spacing.four * 2 - Spacing.three * 2, 360);
  const picture = (size * MODULES) / SHOWN;
  const crop = -(picture - size) / 2;

  return (
    <RefreshScreen onRefresh={load} edges={['top', 'bottom', 'left', 'right']}>
      <BackHeader title="Rewards" />
      {settings === undefined ? null : !settings?.rewards_qr ? (
        <EmptyState icon="🎟️" title="No rewards card yet" subtitle="Dino has not added his Cinemark QR code to the app yet." />
      ) : (
        <View style={styles.card}>
          <Bulbs />
          <Text style={styles.brand}>{settings.rewards_label ?? 'Cinemark Platinum Rewards'}</Text>
          <Text style={styles.deal}>25% off ALL concessions!</Text>
          <View style={[styles.qrFrame, { width: size, height: size }]}>
            <Image
              source={{ uri: settings.rewards_qr }}
              style={{ position: 'absolute', left: crop, top: crop, width: picture, height: picture }}
              contentFit="fill"
              accessibilityLabel="Dino's Cinemark Platinum Rewards QR code"
            />
          </View>
          <Text style={styles.how}>Scan this when you buy concessions at Cinemark Theaters!</Text>
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
    padding: Spacing.three,
    paddingVertical: Spacing.four,
    gap: Spacing.two,
    alignItems: 'center',
  },
  bulbs: { flexDirection: 'row', justifyContent: 'space-between', alignSelf: 'stretch' },
  bulb: { width: 6, height: 6, borderRadius: 3, backgroundColor: GOLD },
  bulbDim: { opacity: 0.35 },
  brand: { fontFamily: Font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 3, textTransform: 'uppercase', color: GOLD, textAlign: 'center', marginTop: Spacing.one },
  deal: { fontFamily: Font.serifBold, fontSize: 30, lineHeight: 36, letterSpacing: -0.4, color: GOLD, textAlign: 'center' },
  // White all around the code: a scanner needs that quiet border.
  qrFrame: { backgroundColor: '#FFFFFF', borderRadius: Radius.md, overflow: 'hidden', marginVertical: Spacing.two },
  how: { fontFamily: Font.bold, fontSize: 17, lineHeight: 23, color: '#FFFFFF', textAlign: 'center' },
  tip: { fontFamily: Font.regular, fontSize: 12, lineHeight: 17, color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: Spacing.one },
});
