// Putting a movie night in the phone's own calendar. Entirely optional:
// nothing in the app depends on it, and the server never hears about it.
//
// The device calendar's id for the entry is remembered on this phone, per
// event, so after a reschedule the same entry is updated instead of a second
// one appearing.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { calendarEnd, calendarLocation, calendarNotes, type CalendarEntry } from '@/lib/links';

type CalendarModule = typeof import('expo-calendar');

export type CalendarResult =
  | { ok: true; updated: boolean }
  | { ok: false; reason: 'denied' | 'unavailable' | 'failed' };

interface Saved {
  id: string;
  revision: number;
}

const key = (eventId: string) => `opening-night.calendar.${eventId}`;

async function saved(eventId: string): Promise<Saved | null> {
  try {
    const raw = await AsyncStorage.getItem(key(eventId));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

/** Whether this phone already has the entry, and whether it is out of date. */
export async function calendarState(eventId: string, revision: number): Promise<'none' | 'current' | 'stale'> {
  const entry = await saved(eventId);
  if (!entry) return 'none';
  return entry.revision === revision ? 'current' : 'stale';
}

// expo-calendar is a native module: importing it at module scope would take
// the event page down on a build compiled without it.
async function loadCalendar(): Promise<CalendarModule | null> {
  try {
    return await import('expo-calendar');
  } catch {
    return null;
  }
}

async function writableCalendarId(Calendar: CalendarModule): Promise<string | null> {
  if (Platform.OS === 'ios') {
    const preferred = await Calendar.getDefaultCalendarAsync();
    if (preferred?.id) return preferred.id;
  }
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  return calendars.find((calendar) => calendar.allowsModifications)?.id ?? null;
}

/** Adds the night to the device calendar, or updates the entry already there. */
export async function saveToCalendar(entry: CalendarEntry): Promise<CalendarResult> {
  const Calendar = await loadCalendar();
  if (!Calendar) return { ok: false, reason: 'unavailable' };
  try {
    const { granted } = await Calendar.requestCalendarPermissionsAsync();
    if (!granted) return { ok: false, reason: 'denied' };

    const details = {
      title: entry.title,
      startDate: new Date(entry.startsAt),
      endDate: calendarEnd(entry),
      location: calendarLocation(entry) || undefined,
      notes: calendarNotes(entry),
      alarms: [{ relativeOffset: -120 }],
    };

    const existing = await saved(entry.eventId);
    if (existing) {
      try {
        await Calendar.updateEventAsync(existing.id, details);
        await AsyncStorage.setItem(key(entry.eventId), JSON.stringify({ id: existing.id, revision: entry.revision }));
        return { ok: true, updated: true };
      } catch {
        // The member deleted it from their calendar; fall through and add it again.
      }
    }

    const calendarId = await writableCalendarId(Calendar);
    if (!calendarId) return { ok: false, reason: 'unavailable' };
    const id = await Calendar.createEventAsync(calendarId, details);
    await AsyncStorage.setItem(key(entry.eventId), JSON.stringify({ id, revision: entry.revision }));
    return { ok: true, updated: false };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
