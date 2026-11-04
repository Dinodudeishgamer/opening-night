import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { createElement, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { DATE_LOCALE, dayTime } from '@/lib/format';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type DateTimeFieldProps = {
  value: Date;
  onChange: (date: Date) => void;
  label?: string;
  hint?: string;
};

/**
 * Date + time entry that works the same everywhere it needs to, and always
 * the American way: month before day, 12-hour clock with AM/PM.
 *
 * Each platform gets what it actually supports: iOS opens Apple's own wheel,
 * Android chains its date dialog into its time dialog (its picker has no
 * combined `datetime` mode), and web, where the native picker doesn't exist
 * at all, gets a wheel built to look and behave like the iOS one. Nothing is
 * typed, so nothing can be typed in the wrong order.
 */
export function DateTimeField({ value, onChange, label, hint }: DateTimeFieldProps) {
  const theme = useTheme();
  const [mode, setMode] = useState<'date' | 'time' | null>(null);

  if (Platform.OS === 'web') return <WheelField value={value} onChange={onChange} label={label} hint={hint} />;

  return (
    <ThemedView style={styles.wrap}>
      {label && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.label}>
          {label}
        </ThemedText>
      )}

      <Pressable
        onPress={() => setMode('date')}
        accessibilityRole="button"
        accessibilityLabel={`Change date and time. Currently ${dayTime(value.toISOString())}`}
        style={({ pressed }) => [
          styles.trigger,
          { borderColor: theme.border, backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement },
        ]}>
        <Ionicons name="calendar-outline" size={18} color={theme.textSecondary} />
        <ThemedText style={styles.triggerText}>{dayTime(value.toISOString())}</ThemedText>
      </Pressable>

      {mode && (
        <DateTimePicker
          value={value}
          mode={Platform.OS === 'ios' ? 'datetime' : mode}
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          // Month-day-year and AM/PM, whatever the phone's region is set to.
          locale={DATE_LOCALE}
          is24Hour={false}
          onChange={(event, selected) => {
            if (Platform.OS === 'ios') {
              if (selected) onChange(selected);
              return;
            }

            // Android dismisses its dialog on every interaction; chain date into
            // time so one tap still sets both.
            if (event.type === 'dismissed') {
              setMode(null);
              return;
            }
            if (selected) onChange(selected);
            setMode(mode === 'date' ? 'time' : null);
          }}
        />
      )}

      {Platform.OS === 'ios' && mode && (
        <Button title="Done" variant="secondary" size="sm" onPress={() => setMode(null)} />
      )}

      {hint && (
        <ThemedText type="small" themeColor="textSecondary">
          {hint}
        </ThemedText>
      )}
    </ThemedView>
  );
}

// ---------------------------------------------------------------------------
// Web: an iOS-style wheel
// ---------------------------------------------------------------------------

const ROW = 36;
const VISIBLE_ROWS = 5;
const WHEEL_HEIGHT = ROW * VISIBLE_ROWS;
const MINUTE_STEP = 5;
const DAYS_BACK = 7;
const DAYS_AHEAD = 400;
const DAY_MS = 86_400_000;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// Whole days between two local midnights; rounding absorbs daylight-saving hours.
const daysBetween = (from: Date, to: Date) => Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * One column of the wheel. A scroll container that snaps a row to the middle;
 * whichever row rests there is the choice. Clicking a row scrolls to it.
 */
function WheelColumn({
  name,
  labels,
  index,
  onPick,
  grow = 1,
  align = 'center',
}: {
  name: string;
  labels: string[];
  index: number;
  onPick: (index: number) => void;
  grow?: number;
  align?: 'center' | 'right' | 'left';
}) {
  const theme = useTheme();
  const node = useRef<HTMLDivElement | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The row most recently reported, so a scroll we caused ourselves is not reported back.
  const reported = useRef(index);

  // Follow the value when it changes from outside (opening the picker, or the
  // list of rows changing). A change this column reported itself is left
  // alone: the wheel is already there, or still gliding there, and moving it
  // would fight the scroll in progress.
  const mounted = useRef(false);
  useEffect(() => {
    const own = mounted.current && reported.current === index;
    mounted.current = true;
    reported.current = index;
    const el = node.current;
    if (!own && el && Math.round(el.scrollTop / ROW) !== index) el.scrollTop = index * ROW;
  }, [index, labels.length]);

  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  const onScroll = () => {
    if (settle.current) clearTimeout(settle.current);
    // Wait for the scroll to come to rest on a row before reading it.
    settle.current = setTimeout(() => {
      const el = node.current;
      if (!el) return;
      const next = Math.min(Math.max(Math.round(el.scrollTop / ROW), 0), labels.length - 1);
      if (next !== reported.current) {
        reported.current = next;
        onPick(next);
      }
    }, 120);
  };

  const fade = 'linear-gradient(to bottom, transparent 0%, black 38%, black 62%, transparent 100%)';

  return createElement(
    'div',
    {
      ref: node,
      role: 'listbox',
      'aria-label': name,
      tabIndex: 0,
      onScroll,
      style: {
        flexGrow: grow,
        flexBasis: 0,
        height: WHEEL_HEIGHT,
        overflowY: 'scroll',
        scrollSnapType: 'y mandatory',
        scrollbarWidth: 'none',
        maskImage: fade,
        WebkitMaskImage: fade,
        outline: 'none',
      },
    },
    // Padding rows so the first and last choices can reach the middle.
    createElement('div', { style: { height: ROW * 2 } }),
    labels.map((text, i) =>
      createElement(
        'div',
        {
          key: i,
          role: 'option',
          'aria-selected': i === index,
          onClick: () => node.current?.scrollTo({ top: i * ROW, behavior: 'smooth' }),
          style: {
            height: ROW,
            lineHeight: `${ROW}px`,
            scrollSnapAlign: 'center',
            textAlign: align,
            padding: `0 ${Spacing.two}px`,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            userSelect: 'none',
            fontFamily: i === index ? Font.bold : Font.medium,
            fontSize: 18,
            color: i === index ? theme.text : theme.textSecondary,
          },
        },
        text,
      ),
    ),
    createElement('div', { style: { height: ROW * 2 } }),
  );
}

/** The web picker: the same one-line trigger as on a phone, opening the wheel. */
function WheelField({ value, onChange, label, hint }: DateTimeFieldProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  const today = startOfDay(new Date());
  // A window of days around today, stretched to include the current value.
  const first = addDays(today, Math.min(-DAYS_BACK, daysBetween(today, value)));
  const dayCount = Math.max(DAYS_BACK + DAYS_AHEAD, daysBetween(first, value) + 30);
  const days = range(0, dayCount).map((offset) => addDays(first, offset));
  const thisYear = today.getFullYear();
  const dayLabels = days.map((d) =>
    daysBetween(today, d) === 0
      ? 'Today'
      : d.toLocaleDateString(DATE_LOCALE, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== thisYear ? { year: 'numeric' } : {}) }),
  );

  const hour24 = value.getHours();
  const minute = value.getMinutes();
  const minutes = range(0, 59).filter((n) => n % MINUTE_STEP === 0 || n === minute);
  const HOURS = [12, ...range(1, 11)];

  // Two columns can come to rest in the same moment, before a re-render. Each
  // change builds on the last one made, not on the value this render saw.
  const latest = useRef(value);
  latest.current = value;
  const set = (parts: { day?: Date; hour24?: number; minute?: number }) => {
    const base = latest.current;
    const day = parts.day ?? base;
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), parts.hour24 ?? base.getHours(), parts.minute ?? base.getMinutes(), 0, 0);
    latest.current = next;
    onChange(next);
  };

  return (
    <ThemedView style={styles.wrap}>
      {label && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.label}>
          {label}
        </ThemedText>
      )}

      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityLabel={`Change date and time. Currently ${dayTime(value.toISOString())}`}
        style={({ pressed }) => [
          styles.trigger,
          { borderColor: open ? theme.accent : theme.border, backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement },
        ]}>
        <Ionicons name="calendar-outline" size={18} color={theme.textSecondary} />
        <ThemedText style={styles.triggerText}>{dayTime(value.toISOString())}</ThemedText>
      </Pressable>

      {open && (
        <>
          <View style={[styles.wheel, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
            {/* The band the chosen row rests in. */}
            <View pointerEvents="none" style={[styles.band, { backgroundColor: theme.backgroundSelected }]} />
            <WheelColumn name="Date" labels={dayLabels} index={daysBetween(first, value)} onPick={(i) => set({ day: days[i] })} grow={3} align="right" />
            <WheelColumn
              name="Hour"
              labels={HOURS.map(String)}
              index={hour24 % 12}
              onPick={(i) => set({ hour24: i + (latest.current.getHours() >= 12 ? 12 : 0) })}
            />
            <WheelColumn
              name="Minute"
              labels={minutes.map((n) => String(n).padStart(2, '0'))}
              index={minutes.indexOf(minute)}
              onPick={(i) => set({ minute: minutes[i] })}
            />
            <WheelColumn name="AM or PM" labels={['AM', 'PM']} index={hour24 >= 12 ? 1 : 0} onPick={(i) => set({ hour24: (latest.current.getHours() % 12) + i * 12 })} align="left" />
          </View>
          <Button title="Done" variant="secondary" size="sm" onPress={() => setOpen(false)} />
        </>
      )}

      {hint && (
        <ThemedText type="small" themeColor="textSecondary">
          {hint}
        </ThemedText>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.one },
  label: { fontFamily: Font.semibold },
  trigger: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.three,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  triggerText: { fontFamily: Font.semibold },
  wheel: {
    flexDirection: 'row',
    height: WHEEL_HEIGHT,
    // Kept phone-width so the columns sit together on a wide screen.
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.two,
    overflow: 'hidden',
  },
  band: {
    position: 'absolute',
    left: Spacing.two,
    right: Spacing.two,
    top: ROW * 2,
    height: ROW,
    borderRadius: Radius.sm,
  },
});
