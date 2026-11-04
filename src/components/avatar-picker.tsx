// Choosing your picture: a photo, your initial, one of a handful of emoji, or
// any emoji at all. Used in the welcome tour and behind the picture on You.
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { MemberAvatar } from '@/components/member-avatar';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useAction } from '@/components/ui/kit';
import { TextField } from '@/components/ui/text-field';
import { Spacing } from '@/constants/theme';
import { actions } from '@/lib/api';
import { showAlert } from '@/lib/dialogs';
import { firstEmoji } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { choosePhotoAvatar } from '@/lib/images';
import { useSession } from '@/lib/session';

const EMOJI = ['🍿', '🎬', '🎟️', '⭐', '👻', '🦖', '🚀', '🧙', '🦸', '🤠', '🐉', '👽', '🧛', '🤖', '🎭', '🕵️'];

/** `onPicked` runs after a choice has been saved. */
export function AvatarPicker({ onPicked, previewSize = 84 }: { onPicked?: () => void; previewSize?: number }) {
  const { me, memberById, refresh } = useSession();
  const { busy, run } = useAction(refresh);
  const [typed, setTyped] = useState('');
  const member = memberById(me?.member_id);
  if (!me) return null;

  const picked = () => {
    haptic.tap();
    setTyped('');
    onPicked?.();
  };
  const apply = async (key: string, work: () => Promise<unknown>) => {
    if (await run(key, work)) picked();
  };
  const pickPhoto = () =>
    run('photo', async () => {
      const result = await choosePhotoAvatar(me.member_id);
      if (result === 'denied') showAlert('No access to photos', 'Allow photo access for Opening Night in Settings to use a photo.');
      if (result === 'done') picked();
    });
  const custom = firstEmoji(typed);

  return (
    <View style={styles.wrap}>
      <View style={styles.preview}>
        <MemberAvatar member={member} size={previewSize} prominent />
      </View>

      <View style={styles.buttons}>
        <View style={styles.fill}>
          <Button title="Photo" icon="image-outline" loading={busy === 'photo'} onPress={pickPhoto} />
        </View>
        <View style={styles.fill}>
          <Button title="Initials" icon="text-outline" variant="secondary" loading={busy === 'initials'} onPress={() => apply('initials', () => actions.setMyAvatar('initials'))} />
        </View>
      </View>

      <ThemedText type="smallBold" themeColor="textSecondary">
        Or an emoji
      </ThemedText>
      <View style={styles.emoji}>
        {EMOJI.map((emoji) => (
          <Chip key={emoji} label={emoji} selected={member?.avatar_kind === 'emoji' && member.avatar_emoji === emoji} onPress={() => void apply('emoji', () => actions.setMyAvatar('emoji', emoji))} />
        ))}
      </View>
      <View style={styles.customRow}>
        <View style={styles.fill}>
          <TextField
            value={typed}
            // Whatever is typed, only its first emoji is kept.
            onChangeText={(text) => setTyped(firstEmoji(text) ?? '')}
            placeholder="Any other emoji"
            autoCorrect={false}
            style={styles.customInput}
          />
        </View>
        <Button title={custom ? `Use ${custom}` : 'Use'} size="sm" disabled={!custom} loading={busy === 'custom'} onPress={() => apply('custom', () => actions.setMyAvatar('emoji', custom))} />
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        Switch your keyboard to emoji and pick any one you like.
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  wrap: { gap: Spacing.three },
  preview: { alignItems: 'center' },
  buttons: { flexDirection: 'row', gap: Spacing.two },
  emoji: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, justifyContent: 'center' },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  customInput: { fontSize: 22, textAlign: 'center' },
});
