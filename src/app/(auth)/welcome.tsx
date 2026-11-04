// Getting in. One door:
//
//   invite code -> the name Dino put on it -> "Sign in"
//
// The code is the whole credential: there is no phone number and no text
// message. Signing in leaves a session on this phone and nowhere else, so a
// new phone, a reinstall, or signing out means asking Dino for a new code.
// That is also how everyone first signs in, Dino included.
//
// There is no other way to make an account: the server only lets Supabase
// Auth create a user for a claim ticket, and it only hands a ticket to
// someone who has just entered a valid invite code.
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { StatusNote } from '@/components/ui/status-note';
import { TextField } from '@/components/ui/text-field';
import { Font, MONO_FONT, type Note, Spacing } from '@/constants/theme';
import { ApiError, callFunction } from '@/lib/api';
import { isInviteCodeComplete } from '@/lib/format';
import { supabase } from '@/lib/supabase';

type Step = 'code' | 'confirm';

const TRY_LATER = 'Too many attempts. Wait a few minutes and try again.';
const CODE_NOT_VALID = 'That code is not valid. Check it with Dino: codes expire and work once.';

export default function WelcomeScreen() {
  const [step, setStep] = useState<Step>('code');
  const [code, setCode] = useState('');
  const [invitee, setInvitee] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const problem = (text: string) => setNote({ text, tone: 'danger' });

  function go(next: Step) {
    setNote(null);
    setStep(next);
  }

  async function guarded(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await work();
    } catch (error) {
      problem(error instanceof ApiError ? error.message : 'Something went wrong. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const checkCode = () =>
    guarded(async () => {
      const { status, body } = await callFunction('invite-preview', { invite_code: code }, { session: false });
      if (status === 200 && body.outcome === 'ok') {
        setInvitee(`${body.first_name} ${body.last_initial}.`);
        go('confirm');
      } else if (status === 429) {
        problem(TRY_LATER);
      } else if (body.outcome === 'invalid_invite' || status === 400) {
        problem(CODE_NOT_VALID);
      } else {
        problem('Could not check that code right now. Try again in a moment.');
      }
    });

  const signIn = () =>
    guarded(async () => {
      const { status, body } = await callFunction('invite-claim-begin', { invite_code: code }, { session: false });
      if (status === 429) return problem(TRY_LATER);
      if (body.outcome === 'invalid_invite' || status === 400) return problem(CODE_NOT_VALID);
      if (status !== 200 || body.outcome !== 'ok' || typeof body.claim_ticket !== 'string') {
        return problem('Could not start sign-in right now. Try again in a moment.');
      }
      // The ticket is what lets Auth create this user, and what ties it to the invite.
      const { error } = await supabase.auth.signInAnonymously({ options: { data: { claim_ticket: body.claim_ticket } } });
      if (error) {
        return problem(error.status === 429 ? TRY_LATER : 'Could not sign you in. Try again, or ask Dino for a new code.');
      }
      // Signed in. The session provider links the invite and takes it from here.
    });

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} contentStyle={styles.content}>
      <View style={styles.brand}>
        <Bulbs />
        <ThemedText type="eyebrow" style={styles.nowShowing}>
          Now showing
        </ThemedText>
        <ThemedText style={styles.wordmark}>Opening Night</ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.center}>
          Movie nights, by invitation.
        </ThemedText>
        <Bulbs />
      </View>

      {step === 'code' && (
        <View style={styles.block}>
          <TextField
            label="Invite code"
            // Left to the keyboard rather than rewritten on every keystroke: an
            // iPhone field whose text the app changes while it is being typed
            // can drop or refuse characters. The server tidies case, spaces
            // and dashes anyway. The plain ASCII keyboard has every letter and
            // digit a code can hold, and no AutoFill bar to type into instead.
            // Coming back from "Not you?" shows what was typed before.
            defaultValue={code}
            onChangeText={(text) => setCode(text.slice(0, 64))}
            maxLength={64}
            keyboardType="ascii-capable"
            textContentType="none"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect={false}
            spellCheck={false}
            placeholder="Your invite code"
            style={styles.code}
            hint="The code Dino gave you. Capitals, spaces and dashes do not matter. New phone, or signed out? Ask him for a new one."
            returnKeyType="go"
            onSubmitEditing={checkCode}
          />
          <Button title="Continue" icon="ticket-outline" onPress={checkCode} loading={busy} disabled={!isInviteCodeComplete(code)} />
        </View>
      )}

      {step === 'confirm' && invitee && (
        <View style={styles.block}>
          <ThemedText type="heading" style={styles.center}>
            Welcome, {invitee}
          </ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.center}>
            This signs you in on this phone and stays signed in. The code works once, and any other phone you were signed in on is signed out.
          </ThemedText>
          <Button title="Sign in" onPress={signIn} loading={busy} />
          <Button title="Not you? Use a different code" variant="secondary" onPress={() => go('code')} />
        </View>
      )}

      <StatusNote note={note} />
    </Screen>
  );
}

/** A row of marquee lights: gold bulbs, every other one dimmed. */
function Bulbs() {
  return (
    <View style={styles.bulbs} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: 13 }, (_, index) => (
        <View key={index} style={[styles.bulb, index % 2 === 1 && styles.bulbDim]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: 'center', gap: Spacing.four },
  brand: { alignItems: 'center', gap: Spacing.one },
  bulbs: { flexDirection: 'row', gap: 10, marginVertical: Spacing.three },
  bulb: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#F2B84B' },
  bulbDim: { opacity: 0.35 },
  nowShowing: { color: '#C8963E' },
  wordmark: { fontFamily: Font.serifBold, fontSize: 40, lineHeight: 46, letterSpacing: -0.8 },
  center: { textAlign: 'center' },
  block: { gap: Spacing.three },
  code: { fontFamily: MONO_FONT, fontSize: 20, letterSpacing: 2, textAlign: 'center' },
});
