// What every section of the event page works from: the loaded event, who is
// looking at it, and the people on it resolved to names.
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { getSettings, loadEvent } from '@/lib/api';
import { memberName } from '@/lib/format';
import type { AppSettings, Charge, EventBundle, Guest, Me, Member, Participant } from '@/lib/types';

export interface Person {
  participant: Participant;
  name: string;
  member?: Member;
  guest?: Guest;
  /** The viewer themselves. */
  isMe: boolean;
  /** The viewer, or a guest the viewer is hosting: someone they answer for. */
  isMine: boolean;
  /** "Guest of Alice A." for guests. */
  note: string | null;
  charge?: Charge;
  prediction?: number;
  predictionActive?: boolean;
  rating?: number;
}

export interface EventCtx {
  bundle: EventBundle;
  settings: AppSettings | null;
  me: Me;
  isOwner: boolean;
  /** Everyone on the event the viewer is allowed to see, in a stable order. */
  people: Person[];
  /** The viewer's own row (if any) followed by their guests'. */
  mine: Person[];
  refresh: () => Promise<void>;
}

export function buildPeople(bundle: EventBundle, me: Me, memberById: (id: string | null | undefined) => Member | undefined): Person[] {
  const guests = new Map(bundle.guests.map((guest) => [guest.id, guest]));
  const charges = new Map(bundle.charges.map((charge) => [charge.participant_id, charge]));
  const predictions = new Map(bundle.predictions.map((row) => [row.participant_id, row]));
  const ratings = new Map(bundle.ratings.map((row) => [row.participant_id, row]));

  const people = bundle.participants.map((participant): Person => {
    const member = memberById(participant.member_id);
    const guest = participant.guest_id ? guests.get(participant.guest_id) : undefined;
    const host = guest ? memberById(guest.host_member_id) : undefined;
    const prediction = predictions.get(participant.id);
    return {
      participant,
      member,
      guest,
      name: guest ? guest.display_name : memberName(member),
      isMe: participant.member_id === me.member_id,
      isMine: participant.member_id === me.member_id || guest?.host_member_id === me.member_id,
      note: guest ? `Guest of ${memberName(host)}` : null,
      charge: charges.get(participant.id),
      prediction: prediction?.score,
      predictionActive: prediction?.is_active,
      rating: ratings.get(participant.id)?.score,
    };
  });

  // Members first by name, each followed by their guests.
  const hostName = (person: Person) => (person.guest ? memberName(memberById(person.guest.host_member_id)) : person.name);
  return people.sort(
    (a, b) => hostName(a).localeCompare(hostName(b)) || Number(Boolean(a.guest)) - Number(Boolean(b.guest)) || a.name.localeCompare(b.name),
  );
}

/** Loads the event when the page gains focus, and again whenever asked. */
export function useEventBundle(eventId: string) {
  const [bundle, setBundle] = useState<EventBundle | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>('loading');
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const [loaded, saved] = await Promise.all([loadEvent(eventId), getSettings()]);
      if (mine !== latest.current) return;
      setSettings(saved);
      if (!loaded) {
        setBundle(null);
        setState('missing');
      } else {
        setBundle(loaded);
        setState('ready');
      }
    } catch {
      // Keep showing what we have; only an empty page becomes an error page.
      if (mine === latest.current) setState((current) => (current === 'ready' ? 'ready' : 'failed'));
    }
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  return { bundle, settings, state, refresh };
}
