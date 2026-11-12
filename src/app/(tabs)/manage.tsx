// Manage: the club itself. Dino only. Members never see this tab, and every
// action here is refused by the database for anyone who is not the organizer.
//
// Movie-night controls are not here; they live on each night's page.
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { MemberAvatar } from '@/components/member-avatar';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Choices, Row, Sheet, useAction } from '@/components/ui/kit';
import { RefreshScreen } from '@/components/ui/refresh-screen';
import { Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { TextField } from '@/components/ui/text-field';
import { MONO_FONT, Spacing, type Tone } from '@/constants/theme';
import { type Announcement, issueInvite, owner } from '@/lib/api';
import { confirmAction, shareText, showAlert } from '@/lib/dialogs';
import { isInviteCodeComplete, memberName, timeUntil } from '@/lib/format';
import { inviteMessage } from '@/lib/links';
import { useSession } from '@/lib/session';
import type { Member } from '@/lib/types';

type Access = Awaited<ReturnType<typeof owner.memberAccess>>[number];

function accessBadge(member: Member, access: Access | undefined): { label: string; tone: Tone } {
  if (member.status === 'removed') return { label: 'Removed', tone: 'muted' };
  if (member.status === 'deactivated') return { label: 'Paused', tone: 'warning' };
  if (access?.has_login) return { label: 'Signed in', tone: 'success' };
  if (access?.invite_open) return { label: `Invited · expires ${timeUntil(access.invite_expires_at ?? '')}`, tone: 'accent' };
  return { label: 'No way in yet', tone: 'danger' };
}

export default function ManageScreen() {
  const { isOwner, members, refresh: refreshSession } = useSession();
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [selected, setSelected] = useState<Member | null>(null);
  const [adding, setAdding] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const [sent, setSent] = useState<Announcement[]>([]);
  // An invite code that was just issued. Shown once; it is not stored anywhere in the clear.
  const [issued, setIssued] = useState<{ name: string; code: string; custom: boolean } | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const load = useCallback(async () => {
    if (!isOwner) return;
    await refreshSession();
    const [list, announcements] = await Promise.all([owner.memberAccess(), owner.listAnnouncements()]);
    setSent(announcements);
    setAccess(Object.fromEntries(list.map((entry) => [entry.member_id, entry])));
  }, [isOwner, refreshSession]);

  useFocusEffect(
    useCallback(() => {
      void load().catch(() => {});
    }, [load]),
  );

  const { busy, run } = useAction(load);

  if (!isOwner) return <EmptyState icon="🔒" title="Organizer only" />;

  const order = { active: 0, deactivated: 1, removed: 2 } as const;
  const sorted = [...members].sort(
    (a, b) => order[a.status] - order[b.status] || Number(b.role === 'owner') - Number(a.role === 'owner') || a.first_name.localeCompare(b.first_name),
  );

  const removedCount = members.filter((member) => member.status === 'removed').length;

  return (
    <RefreshScreen onRefresh={load}>
      <ThemedText type="heading">Manage</ThemedText>

      <Section title="Members" count={sorted.filter((member) => member.status === 'active').length} right={<Button title="Add" size="sm" icon="person-add-outline" onPress={() => setAdding(true)} />}>
        <View>
        {sorted.filter((member) => showRemoved || member.status !== 'removed').map((member) => {
          const badge = accessBadge(member, access[member.id]);
          return (
            <Row
              key={member.id}
              left={<MemberAvatar member={member} />}
              title={memberName(member)}
              subtitle={member.role === 'owner' ? 'Organizer' : undefined}
              right={<StatusBadge label={badge.label} tone={badge.tone} />}
              onPress={() => setSelected(member)}
            />
          );
        })}
        </View>
        {/* Removed members who were on a past movie night are kept, for their name there, but out of the way. */}
        {removedCount > 0 && (
          <Button
            title={showRemoved ? 'Hide removed members' : `Show ${removedCount} removed`}
            size="sm"
            variant="secondary"
            onPress={() => setShowRemoved(!showRemoved)}
          />
        )}
      </Section>

      <Card>
        <CardTitle kicker="Announce" title="Tell everyone something" icon="megaphone-outline" />
        <ThemedText type="small" themeColor="textSecondary">
          Sends a notification to every active member. Reminders for RSVP, voting, confirming, paying and rating go out on their own.
        </ThemedText>
        <Button title="Write a notification" size="sm" variant="secondary" onPress={() => setAnnouncing(true)} />
      </Card>

      {sent.length > 0 && (
        <Section title="Sent lately" count={sent.length}>
          <View>
            {sent.map((item) => {
              const expired = item.expires_at !== null && new Date(item.expires_at).getTime() <= Date.now();
              const lasts = expired ? 'Expired' : item.expires_at ? `Gone ${timeUntil(item.expires_at)}` : 'Stays until you remove it';
              return (
                <Row
                  key={item.batch}
                  title={item.title}
                  subtitle={`Seen by ${item.seen} of ${item.recipients} · ${lasts}`}
                  right={
                    <Button
                      title="Remove"
                      size="sm"
                      variant="secondary"
                      loading={busy === `remove:${item.batch}`}
                      onPress={() =>
                        confirmAction({
                          title: `Remove "${item.title}"?`,
                          message: 'It disappears from everyone\'s Inbox. A notification that already popped up on a phone cannot be recalled.',
                          confirmLabel: 'Remove',
                          destructive: true,
                          onConfirm: () => void run(`remove:${item.batch}`, () => owner.removeAnnouncement(item.batch)),
                        })
                      }
                    />
                  }
                />
              );
            })}
          </View>
        </Section>
      )}

      <AddMemberSheet
        visible={adding}
        onClose={() => setAdding(false)}
        onIssued={(name, code, custom) => {
          setAdding(false);
          setIssued({ name, code, custom });
          void load();
        }}
      />

      <MemberSheet
        member={selected}
        access={selected ? access[selected.id] : undefined}
        onClose={() => setSelected(null)}
        onChanged={load}
        onIssued={(name, code, custom) => {
          setSelected(null);
          setIssued({ name, code, custom });
          void load();
        }}
      />

      <AnnounceSheet visible={announcing} onClose={() => setAnnouncing(false)} onSent={load} />

      <Sheet visible={issued !== null} title={`Invite for ${issued?.name ?? ''}`} onClose={() => setIssued(null)}>
        <ThemedText themeColor="textSecondary">
          Send this to {issued?.name} privately. Share it for the kind of phone they have: the message has their code and how to install the app on it. The code works once, expires in {issued?.custom ? '48 hours' : '14 days'}, and is shown only now.
        </ThemedText>
        <ThemedText selectable style={styles.code}>
          {issued?.code}
        </ThemedText>
        <Button
          title="Share for iPhone"
          icon="logo-apple"
          onPress={() => void shareText(inviteMessage(issued?.name ?? '', issued?.code ?? '', issued?.custom ?? false, 'iphone'))}
        />
        <Button
          title="Share for Android"
          icon="logo-android"
          variant="secondary"
          onPress={() => void shareText(inviteMessage(issued?.name ?? '', issued?.code ?? '', issued?.custom ?? false, 'android'))}
        />
        <Button title="Done" variant="secondary" onPress={() => setIssued(null)} />
      </Sheet>
    </RefreshScreen>
  );
}

type OnIssued = (name: string, code: string, custom: boolean) => void;

// Empty means "make me a random one", which is always fine.
const customCodeOk = (raw: string) => raw.trim() === '' || isInviteCodeComplete(raw);

function CustomCodeField({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) {
  return (
    <TextField
      label="Custom invite code (optional)"
      value={value}
      onChangeText={(text) => onChangeText(text.slice(0, 64))}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      placeholder="Leave empty for a random code"
      hint={
        value.trim() !== '' && !isInviteCodeComplete(value)
          ? 'Needs 12 to 32 letters and numbers. Spaces and dashes do not count.'
          : 'Something like kirbyisthebest. Easier to guess than a random code, so it expires in 48 hours instead of 14 days.'
      }
    />
  );
}

function AddMemberSheet({ visible, onClose, onIssued }: { visible: boolean; onClose: () => void; onIssued: OnIssued }) {
  const [first, setFirst] = useState('');
  const [initial, setInitial] = useState('');
  const [custom, setCustom] = useState('');
  const { busy, run } = useAction();

  const create = () =>
    run('create', async () => {
      const result = await issueInvite({
        action: 'create_member',
        first_name: first.trim(),
        last_initial: initial.trim().toUpperCase(),
        custom_code: custom.trim() || undefined,
      });
      const name = `${first.trim()} ${initial.trim().toUpperCase()}.`;
      const chosen = custom.trim() !== '';
      setFirst('');
      setInitial('');
      setCustom('');
      onIssued(name, result.inviteCode, chosen);
    });

  return (
    <Sheet visible={visible} title="Add a member" onClose={onClose}>
      <TextField label="First name" value={first} onChangeText={setFirst} autoCapitalize="words" maxLength={40} />
      <TextField label="Last initial" value={initial} onChangeText={(text) => setInitial(text.replace(/[^A-Za-z]/g, '').slice(0, 1))} autoCapitalize="characters" maxLength={1} />
      <CustomCodeField value={custom} onChangeText={setCustom} />
      <ThemedText type="small" themeColor="textSecondary">
        Creates the member and their personal invite code together. They enter the code in the app and they are in.
      </ThemedText>
      <Button
        title="Create member and invite"
        onPress={create}
        loading={busy === 'create'}
        disabled={!first.trim() || initial.trim().length !== 1 || !customCodeOk(custom)}
      />
    </Sheet>
  );
}

function MemberSheet({
  member,
  access,
  onClose,
  onChanged,
  onIssued,
}: {
  member: Member | null;
  access: Access | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onIssued: OnIssued;
}) {
  const [first, setFirst] = useState('');
  const [initial, setInitial] = useState('');
  const [custom, setCustom] = useState('');
  const [renaming, setRenaming] = useState(false);
  const { busy, run } = useAction(onChanged);

  if (!member) return <Sheet visible={false} title="" onClose={onClose}>{null}</Sheet>;
  const name = memberName(member);
  const isOrganizer = member.role === 'owner';

  const then = (work: () => Promise<unknown>, key: string) => async () => {
    if (await run(key, work)) onClose();
  };

  const invite = () =>
    run('invite', async () => {
      // The organizer's own code is always random: it opens everything.
      const chosen = isOrganizer ? '' : custom.trim();
      const result = await issueInvite({ action: 'create_invite', member_id: member.id, custom_code: chosen || undefined });
      setCustom('');
      onIssued(name, result.inviteCode, chosen !== '');
    });

  return (
    <Sheet
      visible
      title={name}
      onClose={() => {
        setRenaming(false);
        onClose();
      }}>
      {renaming ? (
        <>
          <TextField label="First name" value={first} onChangeText={setFirst} autoCapitalize="words" maxLength={40} />
          <TextField label="Last initial" value={initial} onChangeText={(text) => setInitial(text.replace(/[^A-Za-z]/g, '').slice(0, 1))} autoCapitalize="characters" maxLength={1} />
          <Button
            title="Save name"
            loading={busy === 'rename'}
            disabled={!first.trim() || initial.length !== 1}
            onPress={async () => {
              if (await run('rename', () => owner.renameMember(member.id, first.trim(), initial.toUpperCase()))) setRenaming(false);
            }}
          />
        </>
      ) : (
        <Button
          title="Rename"
          variant="secondary"
          icon="create-outline"
          onPress={() => {
            setFirst(member.first_name);
            setInitial(member.last_initial);
            setRenaming(true);
          }}
        />
      )}

      {member.status === 'active' && (
        <>
          <ThemedText type="small" themeColor="textSecondary">
            {access?.has_login
              ? 'They are signed in. A new invite code is for a new phone: using it signs them in there and signs the old phone out.'
              : access?.invite_open
                ? 'They have an open invite. A new one replaces it.'
                : 'They have no way in. Create an invite.'}
          </ThemedText>
          {!isOrganizer && <CustomCodeField value={custom} onChangeText={setCustom} />}
          <Button
            title={access?.invite_open ? 'Replace invite code' : 'Create invite code'}
            icon="ticket-outline"
            onPress={invite}
            loading={busy === 'invite'}
            disabled={!isOrganizer && !customCodeOk(custom)}
          />
          {access?.invite_open && (
            <Button title="Cancel the open invite" variant="secondary" loading={busy === 'revoke'} onPress={then(() => owner.revokeInvite(member.id), 'revoke')} />
          )}
        </>
      )}

      {!isOrganizer && member.status === 'active' && access?.has_login && (
        <Button
          title="Sign them out everywhere"
          variant="secondary"
          icon="refresh-outline"
          onPress={() =>
            confirmAction({
              title: `Reset ${name}'s access?`,
              message: 'They are signed out at once and need a new invite code to get back in. Their history is untouched.',
              confirmLabel: 'Reset',
              destructive: true,
              onConfirm: then(() => owner.resetMemberAccess(member.id), 'reset'),
            })
          }
        />
      )}

      {!isOrganizer && member.status === 'active' && (
        <Button title="Pause access" variant="secondary" icon="pause-outline" loading={busy === 'pause'} onPress={then(() => owner.setMemberStatus(member.id, 'deactivated'), 'pause')} />
      )}
      {!isOrganizer && member.status !== 'active' && (
        <Button title={member.status === 'removed' ? 'Bring back' : 'Resume access'} icon="play-outline" loading={busy === 'resume'} onPress={then(() => owner.setMemberStatus(member.id, 'active'), 'resume')} />
      )}
      {!isOrganizer && member.status !== 'removed' && (
        <Button
          title="Remove from Opening Night"
          variant="destructiveOutline"
          onPress={() =>
            confirmAction({
              title: `Remove ${name}?`,
              message: 'They lose access to the app right away. If they were never part of a movie night, they are deleted completely. Otherwise their name stays on the nights they were at, and they leave this list.',
              confirmLabel: 'Remove',
              destructive: true,
              onConfirm: then(() => owner.setMemberStatus(member.id, 'removed'), 'remove'),
            })
          }
        />
      )}
      {isOrganizer && (
        <ThemedText type="small" themeColor="textSecondary">
          The organizer cannot be paused, removed, or reset from the app.
        </ThemedText>
      )}
    </Sheet>
  );
}

type Lasting = 'day' | 'week' | 'forever';
const LASTS: { value: Lasting; label: string }[] = [
  { value: 'day', label: '1 day' },
  { value: 'week', label: '1 week' },
  { value: 'forever', label: 'Until removed' },
];
const HOURS: Record<Lasting, number | null> = { day: 24, week: 24 * 7, forever: null };

function AnnounceSheet({ visible, onClose, onSent }: { visible: boolean; onClose: () => void; onSent: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [lasting, setLasting] = useState<Lasting>('week');
  const { busy, run } = useAction(onSent);

  const send = () =>
    run('send', async () => {
      const hours = HOURS[lasting];
      const count = await owner.sendNotification(title.trim(), body.trim(), null, hours === null ? null : new Date(Date.now() + hours * 3_600_000).toISOString());
      setTitle('');
      setBody('');
      setLasting('week');
      onClose();
      showAlert('Sent', `Sent to ${count} member${count === 1 ? '' : 's'}.`);
    });

  return (
    <Sheet visible={visible} title="Notify everyone" onClose={onClose}>
      <TextField label="Title" value={title} onChangeText={setTitle} maxLength={120} placeholder="Doors at 7" />
      <TextField label="Message (optional)" value={body} onChangeText={setBody} maxLength={500} multiline placeholder="Meet in the lobby." />
      <ThemedText type="smallBold" themeColor="textSecondary">
        How long it stays in everyone&apos;s Inbox
      </ThemedText>
      <Choices<Lasting> options={LASTS} value={lasting} onChange={setLasting} />
      <ThemedText type="small" themeColor="textSecondary">
        You can remove it sooner from Manage. Nothing stays longer than 30 days.
      </ThemedText>
      <View style={styles.gap}>
        <Button title="Send to everyone" icon="send-outline" onPress={send} loading={busy === 'send'} disabled={!title.trim()} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  code: { fontFamily: MONO_FONT, fontSize: 24, lineHeight: 34, letterSpacing: 2, textAlign: 'center', paddingVertical: Spacing.three },
  gap: { gap: Spacing.two },
});
