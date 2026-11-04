// Small shared pieces the rebuilt screens are made of: a bottom sheet for
// forms, a labelled row, a choice row, a score field, and the hook that runs
// an action with a busy state and a readable failure.
import { Ionicons } from '@expo/vector-icons';
import { ReactNode, useCallback, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Chip } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import { TextField } from '@/components/ui/text-field';
import { Font, Radius, Spacing, type Tone, TONE_COLOR } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { messageOf } from '@/lib/api';
import { showAlert } from '@/lib/dialogs';
import { parseScore } from '@/lib/format';
import { haptic } from '@/lib/haptics';

/**
 * Runs one action at a time. While it runs `busy` names it, so the button
 * that started it can show a spinner and the others can wait. A refusal from
 * the server is shown in its own words.
 */
export function useAction(after?: () => void | Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (name: string, action: () => Promise<unknown>): Promise<boolean> => {
      if (busy) return false;
      setBusy(name);
      try {
        await action();
        await after?.();
        return true;
      } catch (error) {
        showAlert('That did not work', messageOf(error));
        // The state on screen may be stale; that is often why it failed.
        await after?.();
        return false;
      } finally {
        setBusy(null);
      }
    },
    [busy, after],
  );

  return { busy, run };
}

/**
 * A form that slides up over the page. The dimmed backdrop and the sheet are
 * stacked in a column inside the keyboard-avoiding view, so when the keyboard
 * comes up the whole sheet rides up with it and what is being typed stays in
 * view. (Pinning the sheet to the bottom with absolute positioning ignored
 * the keyboard's padding and left the fields underneath it.)
 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* With the keyboard up, a tap outside means "put the keyboard away", not "throw away what I typed". */}
        <Pressable
          style={[styles.fill, { backgroundColor: theme.overlay }]}
          onPress={() => (Keyboard.isVisible() ? Keyboard.dismiss() : onClose())}
          accessibilityLabel="Close"
        />
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.background, borderColor: theme.border, paddingBottom: Math.max(insets.bottom, Spacing.three) },
          ]}>
          <View style={[styles.grabber, { backgroundColor: theme.border }]} />
          <View style={styles.sheetHeader}>
            <ThemedText style={[styles.flex, styles.sheetTitle]} numberOfLines={2}>
              {title}
            </ThemedText>
            <IconButton icon="close" label="Close" size={36} onPress={onClose} />
          </View>
          <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** One line of a list: who or what on the left, state or a control on the right. */
export function Row({
  left,
  title,
  subtitle,
  right,
  onPress,
}: {
  left?: ReactNode;
  title: string;
  subtitle?: string | null;
  right?: ReactNode;
  onPress?: () => void;
}) {
  const body = (
    <View style={styles.row}>
      {left}
      <View style={styles.rowText}>
        <ThemedText style={styles.rowTitle} numberOfLines={1}>
          {title}
        </ThemedText>
        {subtitle ? (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
            {subtitle}
          </ThemedText>
        ) : null}
      </View>
      {right}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => (pressed ? styles.pressed : undefined)}>
      {body}
    </Pressable>
  );
}

/** A single choice out of a few, as a row of pills. */
export function Choices<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.choices, disabled && styles.disabled]} pointerEvents={disabled ? 'none' : 'auto'}>
      {options.map((option) => (
        // Two or three answers share the row evenly, like one control; more than that wrap as pills.
        <View key={option.value} style={options.length <= 3 ? styles.choiceShare : undefined}>
          <Chip
            label={option.label}
            selected={value === option.value}
            onPress={() => {
              if (value !== option.value) haptic.tap();
              onChange(option.value);
            }}
          />
        </View>
      ))}
    </View>
  );
}

/** A 0.00-5.00 score, typed. Says so when what was typed is not one. */
export function ScoreField({ label, value, onChangeText }: { label: string; value: string; onChangeText: (text: string) => void }) {
  const invalid = value.trim() !== '' && parseScore(value) === null;
  return (
    <TextField
      label={label}
      value={value}
      onChangeText={onChangeText}
      keyboardType="decimal-pad"
      placeholder="3.75"
      maxLength={4}
      error={invalid ? '0.00 to 5.00, up to two decimals.' : undefined}
      hint="0.00 to 5.00"
    />
  );
}

/** A short line that states a fact with a tone: a deadline, a lock, a result. */
export function Fact({ icon, text, tone = 'muted' }: { icon: keyof typeof Ionicons.glyphMap; text: string; tone?: Tone }) {
  const theme = useTheme();
  const color = theme[TONE_COLOR[tone]];
  return (
    <View style={styles.fact}>
      <Ionicons name={icon} size={15} color={color} style={styles.factIcon} />
      <ThemedText type="small" style={[styles.flex, { color }]}>
        {text}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, marginBottom: Spacing.two },
  sheetTitle: { fontFamily: Font.serifBold, fontSize: 22, lineHeight: 27, letterSpacing: -0.3 },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  sheetBody: { gap: Spacing.three, paddingBottom: Spacing.three },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, paddingVertical: Spacing.two },
  rowText: { flex: 1, gap: 1 },
  rowTitle: { fontFamily: Font.semibold, fontSize: 15, lineHeight: 20 },
  pressed: { opacity: 0.6 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  choiceShare: { flex: 1 },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: Spacing.two },
  disabled: { opacity: 0.5 },
  fact: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two },
  factIcon: { marginTop: 2 },
});
