// A person's picture on a movie night. Tap it to see it properly: the same
// picture, large, with their name under it. A photo that is a thumbnail in a
// list is somebody's actual face (or dog) at this size.
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { Person } from '@/components/event/context';
import { GuestAvatar, MemberAvatar } from '@/components/member-avatar';
import { Font, Spacing } from '@/constants/theme';
import { haptic } from '@/lib/haptics';

export function Face({ person, size = 36 }: { person: Person; size?: number }) {
  const [open, setOpen] = useState(false);
  const { width } = useWindowDimensions();
  const big = Math.min(width - Spacing.five * 2, 320);
  const picture = (at: number, prominent = false) =>
    person.guest ? <GuestAvatar name={person.name} size={at} /> : <MemberAvatar member={person.member} size={at} prominent={prominent} />;

  return (
    <>
      <Pressable
        onPress={() => {
          haptic.tap();
          setOpen(true);
        }}
        hitSlop={4}
        accessibilityRole="imagebutton"
        accessibilityLabel={`${person.name}'s picture. Tap to enlarge.`}
        style={({ pressed }) => pressed && styles.pressed}>
        {picture(size)}
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Close">
          <View style={styles.ring}>{picture(big, true)}</View>
          <Text style={styles.name}>{person.name}</Text>
          {person.note ? <Text style={styles.note}>{person.note}</Text> : null}
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  ring: { padding: 5, borderRadius: 999, borderWidth: 2, borderColor: '#F2B84B', marginBottom: Spacing.two },
  name: { fontFamily: Font.serifBold, fontSize: 28, lineHeight: 34, color: '#FFFFFF', textAlign: 'center' },
  note: { fontFamily: Font.medium, fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.7)', textAlign: 'center' },
});
