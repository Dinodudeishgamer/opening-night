// One movie night, one page, from "are you in?" to the photos. The page does
// not change into other pages as the night moves along: sections appear when
// their question is live and give way when it is not.
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';

import { buildPeople, type EventCtx, useEventBundle } from '@/components/event/context';
import { Hero } from '@/components/event/hero';
import { ConfirmSection, PaymentSection, PredictionSection, RatingSection, RsvpSection, VotingSection } from '@/components/event/member-sections';
import { OwnerPanel } from '@/components/event/owner-panel';
import { PeopleSection, ResultsSection } from '@/components/event/people-results';
import { PhotosSection } from '@/components/event/photos-section';
import { BackHeader } from '@/components/ui/back-header';
import { EmptyState } from '@/components/ui/empty-state';
import { RefreshScreen } from '@/components/ui/refresh-screen';
import { useSession } from '@/lib/session';

export default function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me, isOwner, memberById } = useSession();
  const { bundle, settings, state, refresh } = useEventBundle(id);
  const [managing, setManaging] = useState<string | null>(null);

  const ctx = useMemo<EventCtx | null>(() => {
    if (!bundle || !me) return null;
    const people = buildPeople(bundle, me, memberById);
    const mine = people.filter((person) => person.isMine).sort((a, b) => Number(b.isMe) - Number(a.isMe));
    return { bundle, settings, me, isOwner, people, mine, refresh };
  }, [bundle, settings, me, isOwner, memberById, refresh]);

  if (!ctx) {
    return (
      <RefreshScreen onRefresh={refresh} edges={['top', 'bottom', 'left', 'right']}>
        <BackHeader />
        {state === 'missing' ? (
          <EmptyState icon="🎞️" title="This movie night is gone" subtitle="Dino deleted it, or the link is old." />
        ) : state === 'failed' ? (
          <EmptyState icon="📡" title="Could not load" subtitle="Check your connection and pull down to try again." />
        ) : (
          <EmptyState loading title="Loading" />
        )}
      </RefreshScreen>
    );
  }

  // Looked up fresh on every render, so the organizer's sheet reflects what an action just changed.
  const managed = managing ? (ctx.people.find((person) => person.participant.id === managing) ?? null) : null;

  return (
    // No top inset: the hero's still runs up under the status bar and carries the back button.
    <RefreshScreen onRefresh={refresh} edges={['bottom', 'left', 'right']}>
      <Hero ctx={ctx} />
      {isOwner && <OwnerPanel ctx={ctx} person={managed} onClosePerson={() => setManaging(null)} />}
      <RatingSection ctx={ctx} />
      <PaymentSection ctx={ctx} />
      <ConfirmSection ctx={ctx} />
      <RsvpSection ctx={ctx} />
      <VotingSection ctx={ctx} />
      <PredictionSection ctx={ctx} />
      <ResultsSection ctx={ctx} onPress={isOwner ? (person) => setManaging(person.participant.id) : undefined} />
      <PhotosSection ctx={ctx} />
      <PeopleSection ctx={ctx} onPress={isOwner ? (person) => setManaging(person.participant.id) : undefined} />
    </RefreshScreen>
  );
}
