// Check-in at the theater. Dino only, full screen, one big tap per person.
//
// Each row shows what Dino needs at the door: did they confirm, have they
// predicted, have they paid. Whether someone has predicted is shown; what
// they predicted is not, so Dino stays as blind as everyone else until he
// has made his own. A missing prediction can be typed in right here and is
// saved in the same step as the check-in.
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { buildPeople, type Person, useEventBundle } from '@/components/event/context';
import { eventTitle } from '@/components/event-card';
import { GuestAvatar, MemberAvatar } from '@/components/member-avatar';
import { ThemedText } from '@/components/themed-text';
import { BackHeader } from '@/components/ui/back-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { EmptyState } from '@/components/ui/empty-state';
import { Choices, Fact, ScoreField, Sheet, useAction } from '@/components/ui/kit';
import { RefreshScreen } from '@/components/ui/refresh-screen';
import { StatusBadge } from '@/components/ui/status-badge';
import { TextField } from '@/components/ui/text-field';
import { Font, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { owner } from '@/lib/api';
import { CONFIRMATION_LABEL, memberName, money, parseScore } from '@/lib/format';
import { useSession } from '@/lib/session';

export default function CheckInScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me, isOwner, members, memberById } = useSession();
  const { bundle, state, refresh } = useEventBundle(id);
  const { busy, run } = useAction(refresh);
  const [asking, setAsking] = useState<Person | null>(null);
  const [draft, setDraft] = useState('');
  const [walkIn, setWalkIn] = useState(false);

  // Whether each person has predicted comes from the organizer's roster: the
  // predictions themselves are hidden from Dino until he has made his own.
  const [predicted, setPredicted] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!isOwner || !bundle) return;
    let current = true;
    owner
      .roster(id)
      .then((roster) => {
        if (current) setPredicted(new Set(roster.filter((row) => row.has_prediction).map((row) => row.participant_id)));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [id, isOwner, bundle]);

  const people = useMemo(() => (bundle && me ? buildPeople(bundle, me, memberById) : []), [bundle, me, memberById]);

  if (!isOwner) {
    return (
      <RefreshScreen onRefresh={refresh} edges={['top', 'bottom', 'left', 'right']}>
        <BackHeader />
        <EmptyState icon="🔒" title="Organizer only" />
      </RefreshScreen>
    );
  }
  if (!bundle) {
    return (
      <RefreshScreen onRefresh={refresh} edges={['top', 'bottom', 'left', 'right']}>
        <BackHeader />
        <EmptyState loading={state === 'loading'} icon="🎞️" title={state === 'loading' ? 'Loading' : 'Could not load this movie night'} />
      </RefreshScreen>
    );
  }

  const { event } = bundle;
  const hasPrediction = predicted;
  // Expected first (confirmed, then undecided), then the people who said no, who can still turn up.
  const rank = (person: Person) =>
    person.participant.confirmation_status === 'attending' ? 0 : person.participant.rsvp_status === 'cant_go' || person.participant.confirmation_status === 'not_attending' ? 2 : 1;
  const list = [...people].sort((a, b) => rank(a) - rank(b));
  const checkedIn = people.filter((person) => person.participant.checked_in_at).length;
  const onList = new Set(people.filter((person) => person.member).map((person) => person.member!.id));

  function tap(person: Person) {
    if (person.participant.checked_in_at) {
      void run(person.participant.id, () => owner.undoCheckIn(person.participant.id));
    } else if (hasPrediction.has(person.participant.id) || event.ended_at) {
      void run(person.participant.id, () => owner.checkIn(person.participant.id, null));
    } else {
      setDraft('');
      setAsking(person);
    }
  }

  const value = parseScore(draft);

  return (
    <RefreshScreen onRefresh={refresh} edges={['top', 'bottom', 'left', 'right']}>
      <BackHeader title="Check-in" />
      <View>
        <ThemedText style={styles.title}>{eventTitle(event)}</ThemedText>
        <ThemedText themeColor="textSecondary">
          {checkedIn} checked in · {people.filter((person) => person.participant.confirmation_status === 'attending').length} confirmed
        </ThemedText>
      </View>
      {!event.selected_showtime_id && <Fact icon="alert-circle-outline" tone="warning" text="Select a showtime before checking anyone in." />}

      {list.map((person) => {
        const p = person.participant;
        const checked = p.checked_in_at !== null;
        return (
          <Pressable
            key={p.id}
            onPress={() => tap(person)}
            disabled={busy !== null || !event.selected_showtime_id}
            accessibilityRole="button"
            accessibilityLabel={checked ? `Undo check-in for ${person.name}` : `Check in ${person.name}`}>
            <Card style={[styles.row, checked && { borderColor: theme.success }]}>
              {person.guest ? <GuestAvatar name={person.name} size={44} /> : <MemberAvatar member={person.member} size={44} />}
              <View style={styles.text}>
                <ThemedText style={styles.name}>{person.name}</ThemedText>
                {person.note && <ThemedText type="small" themeColor="textSecondary">{person.note}</ThemedText>}
                <View style={styles.badges}>
                  <StatusBadge
                    label={p.confirmation_status ? CONFIRMATION_LABEL[p.confirmation_status] : p.rsvp_status === 'cant_go' ? "Can't Go" : 'No answer'}
                    tone={p.confirmation_status === 'attending' ? 'success' : 'muted'}
                  />
                  <StatusBadge label={hasPrediction.has(p.id) ? 'Predicted' : 'No prediction'} tone={hasPrediction.has(p.id) ? 'success' : 'warning'} />
                  {person.charge && (
                    <StatusBadge
                      label={person.charge.status === 'paid' ? 'Paid' : `Owes ${money(person.charge.amount_cents)}`}
                      tone={person.charge.status === 'paid' ? 'success' : 'danger'}
                    />
                  )}
                </View>
              </View>
              <Ionicons name={checked ? 'checkmark-circle' : 'ellipse-outline'} size={34} color={checked ? theme.success : theme.textSecondary} />
            </Card>
          </Pressable>
        );
      })}

      {event.selected_showtime_id && <Button title="Add a walk-in" icon="person-add-outline" variant="secondary" onPress={() => setWalkIn(true)} />}

      <Sheet visible={asking !== null} title={`Check in ${asking?.name ?? ''}`} onClose={() => setAsking(null)}>
        <ThemedText themeColor="textSecondary">No prediction yet. Ask them now, or check them in without one.</ThemedText>
        <ScoreField label="Their prediction" value={draft} onChangeText={setDraft} />
        <Button
          title="Check in with this prediction"
          disabled={value === null}
          loading={busy === 'with'}
          onPress={async () => {
            if (asking && (await run('with', () => owner.checkIn(asking.participant.id, value)))) setAsking(null);
          }}
        />
        <Button
          title="Check in without one"
          variant="secondary"
          loading={busy === 'without'}
          onPress={async () => {
            if (asking && (await run('without', () => owner.checkIn(asking.participant.id, null)))) setAsking(null);
          }}
        />
      </Sheet>

      <WalkInSheet
        visible={walkIn}
        onClose={() => setWalkIn(false)}
        eventId={event.id}
        ticketsBought={event.tickets_purchased_at !== null}
        candidates={members.filter((member) => member.status === 'active' && !onList.has(member.id)).map((member) => ({ id: member.id, name: memberName(member) }))}
        hosts={members.filter((member) => member.status === 'active').map((member) => ({ id: member.id, name: memberName(member) }))}
        onDone={refresh}
      />
    </RefreshScreen>
  );
}

function WalkInSheet({
  visible, onClose, eventId, ticketsBought, candidates, hosts, onDone,
}: {
  visible: boolean;
  onClose: () => void;
  eventId: string;
  ticketsBought: boolean;
  candidates: { id: string; name: string }[];
  hosts: { id: string; name: string }[];
  onDone: () => Promise<void>;
}) {
  const [kind, setKind] = useState<'member' | 'guest'>('guest');
  const [memberId, setMemberId] = useState<string | null>(null);
  const [guestName, setGuestName] = useState('');
  const [hostId, setHostId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const { busy, run } = useAction(onDone);
  const prediction = draft.trim() === '' ? null : parseScore(draft);
  const ready = (kind === 'member' ? memberId !== null : guestName.trim() !== '' && hostId !== null) && (draft.trim() === '' || prediction !== null);

  const add = async () => {
    const who = kind === 'member' ? { memberId: memberId! } : { guestName: guestName.trim(), hostMemberId: hostId! };
    if (await run('add', () => owner.addWalkIn(eventId, who, prediction))) {
      setMemberId(null);
      setGuestName('');
      setHostId(null);
      setDraft('');
      onClose();
    }
  };

  return (
    <Sheet visible={visible} title="Add a walk-in" onClose={onClose}>
      <Choices<'member' | 'guest'> options={[{ value: 'guest', label: 'A guest' }, { value: 'member', label: 'A member' }]} value={kind} onChange={setKind} />
      {kind === 'member' ? (
        candidates.length === 0 ? (
          <ThemedText type="small" themeColor="textSecondary">Every active member is already on the list above.</ThemedText>
        ) : (
          <View style={styles.badges}>
            {candidates.map((member) => (
              <Chip key={member.id} label={member.name} selected={memberId === member.id} onPress={() => setMemberId(member.id)} />
            ))}
          </View>
        )
      ) : (
        <>
          <TextField label="Guest's name" value={guestName} onChangeText={setGuestName} autoCapitalize="words" maxLength={60} />
          <ThemedText type="smallBold">Who brought them?</ThemedText>
          <View style={styles.badges}>
            {hosts.map((member) => (
              <Chip key={member.id} label={member.name} selected={hostId === member.id} onPress={() => setHostId(member.id)} />
            ))}
          </View>
        </>
      )}
      <ScoreField label="Their prediction (optional)" value={draft} onChangeText={setDraft} />
      <Fact
        icon="information-circle-outline"
        text={ticketsBought ? 'They are added as attending, checked in, and charged the same as everyone else. You can change the amount afterwards.' : 'They are added as attending and checked in. They get a charge when you record the tickets.'}
      />
      <Button title="Add and check in" onPress={add} loading={busy === 'add'} disabled={!ready} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: Font.serifBold, fontSize: 24, lineHeight: 30 },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  text: { flex: 1, gap: 2 },
  name: { fontFamily: Font.bold, fontSize: 17, lineHeight: 22 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one + 2, marginTop: 2 },
});
