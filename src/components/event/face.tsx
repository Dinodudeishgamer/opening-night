// A person's picture. Tap it to see it properly: the same picture, large,
// with their name under it. A photo that is a thumbnail in a list is
// somebody's actual face (or dog) at this size.
import { type ReactNode, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { Person } from '@/components/event/context';
import { GuestAvatar, MemberAvatar } from '@/components/member-avatar';
import { Font, Spacing } from '@/constants/theme';
import { memberName } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import type { Member } from '@/lib/types';

/** Someone on a movie night: a member or a guest. */
export function Face({ person, size = 36 }: { person: Person; size?: number }) {
  return (
    <Zoomable name={person.name} note={person.note} picture={(at, prominent) => (person.guest ? <GuestAvatar name={person.name} size={at} /> : <MemberAvatar member={person.member} size={at} prominent={prominent} />)} size={size} />
  );
}

/** A member anywhere else in the app. */
export function MemberFace({ member, size = 40 }: { member: Member | undefined; size?: number }) {
  return <Zoomable name={memberName(member)} note={null} picture={(at, prominent) => <MemberAvatar member={member} size={at} prominent={prominent} />} size={size} />;
}

function Zoomable({ name, note, picture, size }: { name: string; note: string | null; picture: (size: number, prominent: boolean) => ReactNode; size: number }) {
  const [open, setOpen] = useState(false);
  const { width } = useWindowDimensions();
  const big = Math.min(width - Spacing.five * 2, 320);

  return (
    <>
      <Pressable
        onPress={() => {
          haptic.tap();
          setOpen(true);
        }}
        hitSlop={4}
        accessibilityRole="imagebutton"
        accessibilityLabel={`${name}'s picture. Tap to enlarge.`}
        style={({ pressed }) => pressed && styles.pressed}>
        {picture(size, false)}
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Close">
          <View style={styles.ring}>{picture(big, true)}</View>
          <Text style={styles.name}>{name}</Text>
          {note ? <Text style={styles.note}>{note}</Text> : null}
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
