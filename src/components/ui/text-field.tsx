import { useId, useState } from 'react';
import { InputAccessoryView, Keyboard, Platform, Pressable, StyleSheet, TextInput, TextInputProps, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type TextFieldProps = TextInputProps & {
  label?: string;
  hint?: string;
  error?: string;
};

export function TextField({ label, hint, error, style, onFocus, onBlur, multiline, ...rest }: TextFieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  // iOS has no key that puts the keyboard away (the number pad has no Return
  // at all), and tapping outside a field also taps whatever is there. So
  // every field carries a bar above the keyboard with a Done button.
  const accessoryId = `done-${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const doneBar = Platform.OS === 'ios';

  const borderColor = error ? theme.danger : focused ? theme.accent : theme.border;

  return (
    <View style={styles.wrapper}>
      {label && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.label}>
          {label}
        </ThemedText>
      )}
      <TextInput
        placeholderTextColor={theme.textSecondary}
        inputAccessoryViewID={doneBar ? accessoryId : undefined}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        multiline={multiline}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          {
            color: theme.text,
            borderColor,
            backgroundColor: theme.backgroundElement,
          },
          style,
        ]}
        {...rest}
      />
      {doneBar && (
        <InputAccessoryView nativeID={accessoryId}>
          <View style={[styles.doneBar, { backgroundColor: theme.backgroundElement, borderTopColor: theme.border }]}>
            <Pressable onPress={Keyboard.dismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Hide the keyboard">
              <ThemedText style={{ color: theme.accent, fontFamily: Font.bold }}>Done</ThemedText>
            </Pressable>
          </View>
        </InputAccessoryView>
      )}
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error}
        </ThemedText>
      ) : hint ? (
        <ThemedText type="small" themeColor="textSecondary">
          {hint}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: Spacing.one },
  label: { fontFamily: Font.semibold },
  doneBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    minHeight: 50,
    // Constant width, colour-only focus: growing the border to 2px on focus
    // re-laid the field out and nudged the text a pixel every time the caret
    // landed in it.
    borderWidth: 1.5,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    // Every other surface in the app is Inter; without this inputs alone fell
    // back to the platform's system face.
    fontFamily: Font.regular,
    fontSize: 16,
  },
  // Android vertically centers multiline text by default; pin it to the top
  // and give the field room to read as a text area.
  inputMultiline: {
    minHeight: 96,
    paddingTop: Spacing.two + 2,
    textAlignVertical: 'top',
  },
});
