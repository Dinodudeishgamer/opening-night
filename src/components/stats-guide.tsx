// What the numbers mean, in plain words. Every stat the app shows is defined
// here once, and the screens that show stats link to it, so nobody has to ask
// what "closest guess" is.
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Sheet } from '@/components/ui/kit';
import { Font, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { MAX_SCORE } from '@/lib/format';

interface Entry {
  icon: keyof typeof Ionicons.glyphMap;
  term: string;
  meaning: string;
}

const NIGHT: Entry[] = [
  { icon: 'star', term: 'Group rating', meaning: `Everyone's rating after the movie, averaged. Out of ${MAX_SCORE}.` },
  { icon: 'sparkles', term: 'Group guess', meaning: 'Everyone’s guess from before the movie, averaged. Guesses are locked in before the lights go down.' },
  { icon: 'swap-vertical', term: 'Beat or missed our guess', meaning: 'Group rating minus group guess. +0.40 means the movie was 0.40 better than we thought it would be.' },
  { icon: 'locate', term: 'Guess accuracy', meaning: 'How close the guesses landed. 100% means every guess was dead on; each tenth of a point off costs 2%.' },
  { icon: 'ribbon', term: 'Closest guess', meaning: 'Whoever’s guess landed nearest to their own rating. They called it.' },
  { icon: 'people', term: 'Ties', meaning: 'When people are level on any of these, they share it. Up to three are named; more than that shows as a count.' },
  { icon: 'trending-up', term: 'Biggest surprise', meaning: 'Whoever liked it the most above their own guess.' },
  { icon: 'trending-down', term: 'Biggest letdown', meaning: 'Whoever it fell furthest short for, against their own guess.' },
  { icon: 'heart', term: 'Biggest fan', meaning: 'The highest rating of the night.' },
  { icon: 'thumbs-down', term: 'Toughest critic', meaning: 'The lowest rating of the night.' },
];

const YOURS: Entry[] = [
  { icon: 'film', term: 'Nights', meaning: 'Movie nights you were checked in at.' },
  { icon: 'star', term: 'Avg rating', meaning: `Your own ratings, averaged. Out of ${MAX_SCORE}.` },
  { icon: 'locate', term: 'Accuracy', meaning: 'How close your guesses land to your own ratings, across every night. 100% is dead on; each tenth of a point off costs 2%.' },
];

const PAST: Entry[] = [
  { icon: 'film', term: 'Films', meaning: 'Movie nights the club has finished.' },
  { icon: 'star', term: 'Avg rating', meaning: `The group rating of every night, averaged. Out of ${MAX_SCORE}.` },
  { icon: 'trophy', term: 'Best so far', meaning: 'The highest group rating any night has had.' },
];

const SETS = { night: NIGHT, yours: YOURS, past: PAST } as const;

/** A quiet "What do these mean?" link that opens the definitions for one screen's numbers. */
export function StatsGuide({ about }: { about: keyof typeof SETS }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={8} accessibilityRole="button" style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
        <Ionicons name="help-circle-outline" size={15} color={theme.textSecondary} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.linkText}>
          What do these mean?
        </ThemedText>
      </Pressable>
      <Sheet visible={open} title="What the numbers mean" onClose={() => setOpen(false)}>
        {SETS[about].map((entry) => (
          <View key={entry.term} style={styles.entry}>
            <View style={[styles.icon, { backgroundColor: theme.backgroundSelected }]}>
              <Ionicons name={entry.icon} size={16} color={theme.accent} />
            </View>
            <View style={styles.text}>
              <ThemedText style={styles.term}>{entry.term}</ThemedText>
              <ThemedText themeColor="textSecondary" style={styles.meaning}>
                {entry.meaning}
              </ThemedText>
            </View>
          </View>
        ))}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  linkText: { textDecorationLine: 'underline' },
  entry: { flexDirection: 'row', gap: Spacing.three, alignItems: 'flex-start' },
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  text: { flex: 1, gap: 1 },
  term: { fontFamily: Font.bold, fontSize: 15, lineHeight: 21 },
  meaning: { fontSize: 14, lineHeight: 20 },
});
