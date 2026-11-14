// The Club side of Past: every member, with what their movie nights add up
// to. Sorted by most nights, A to Z, or guess accuracy; tap someone for
// their profile, or their picture to see it big.
import { Ionicons } from '@expo/vector-icons';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { MemberFace } from '@/components/event/face';
import { LetterboxdMark } from '@/components/letterboxd';
import { ThemedText } from '@/components/themed-text';
import { Chip } from '@/components/ui/chip';
import { Font, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { memberName, score } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import type { MemberTotals } from '@/lib/stats';
import type { Member } from '@/lib/types';

type Order = 'nights' | 'name' | 'accuracy';
const ORDERS: { value: Order; label: string }[] = [
  { value: 'nights', label: 'Most nights' },
  { value: 'name', label: 'A to Z' },
  { value: 'accuracy', label: 'Best guessers' },
];

export function ClubList({ members, totals }: { members: Member[]; totals: Record<string, MemberTotals> }) {
  const theme = useTheme();
  const router = useRouter();
  const [order, setOrder] = useState<Order>('nights');

  const of = (member: Member) => totals[member.id] ?? { nights: 0, averageRating: null, accuracy: null, rated: [] };
  const byName = (a: Member, b: Member) => memberName(a).localeCompare(memberName(b));
  const sorted = [...members].sort((a, b) => {
    if (order === 'name') return byName(a, b);
    if (order === 'accuracy') return (of(b).accuracy ?? -1) - (of(a).accuracy ?? -1) || of(b).nights - of(a).nights || byName(a, b);
    return of(b).nights - of(a).nights || byName(a, b);
  });

  return (
    <View style={styles.wrap}>
      <View style={styles.orders}>
        {ORDERS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={order === option.value}
            onPress={() => {
              if (order !== option.value) haptic.tap();
              setOrder(option.value);
            }}
          />
        ))}
      </View>
      <View>
        {sorted.map((member, index) => {
          const totalsFor = of(member);
          const facts = [
            `${totalsFor.nights} night${totalsFor.nights === 1 ? '' : 's'}`,
            totalsFor.averageRating !== null ? `avg ${score(totalsFor.averageRating)}` : null,
            totalsFor.accuracy !== null ? `${totalsFor.accuracy}% accurate` : null,
          ].filter(Boolean);
          return (
            <Pressable
              key={member.id}
              onPress={() => router.push(`/member/${member.id}` as Href)}
              accessibilityRole="button"
              accessibilityLabel={`${memberName(member)}, ${facts.join(', ')}`}
              style={({ pressed }) => [styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border }, pressed && styles.pressed]}>
              <ThemedText style={[styles.rank, { color: theme.textSecondary }]}>{order === 'name' ? '' : index + 1}</ThemedText>
              <MemberFace member={member} size={44} />
              <View style={styles.text}>
                <View style={styles.nameRow}>
                  <ThemedText style={styles.name} numberOfLines={1}>
                    {memberName(member)}
                    {member.role === 'owner' ? <ThemedText type="small" style={{ color: theme.accent }}>{'  Organizer'}</ThemedText> : null}
                  </ThemedText>
                  {/* Linked their Letterboxd: the dots say so at a glance. */}
                  {member.letterboxd ? <LetterboxdMark size={10} /> : null}
                </View>
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                  {facts.join(' · ')}
                </ThemedText>
              </View>
              <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.three },
  orders: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, paddingVertical: Spacing.two + 2 },
  pressed: { opacity: 0.7 },
  rank: { width: 18, textAlign: 'right', fontFamily: Font.bold, fontSize: 13 },
  text: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  name: { flexShrink: 1, fontFamily: Font.semibold, fontSize: 16, lineHeight: 21 },
});
