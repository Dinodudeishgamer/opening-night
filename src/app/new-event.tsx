// Starting a movie night. Dino only.
//
// Search TMDB (through the server, which holds the key), pick the movie,
// choose the poster and backdrop, optionally reword the title and description
// and add a note, and set the RSVP deadline. No date or time is asked for
// here: a movie night gets those when a showtime is selected.
import { Image } from 'expo-image';
import { type Href, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { BackHeader } from '@/components/ui/back-header';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { DateTimeField } from '@/components/ui/datetime-field';
import { EmptyState } from '@/components/ui/empty-state';
import { Row, useAction } from '@/components/ui/kit';
import { Poster } from '@/components/ui/poster';
import { Screen } from '@/components/ui/screen';
import { StatusNote } from '@/components/ui/status-note';
import { TextField } from '@/components/ui/text-field';
import { type Note, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { messageOf, movieDetails, owner, searchMovies } from '@/lib/api';
import { showAlert } from '@/lib/dialogs';
import { tmdbImage } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { TmdbDetails, TmdbSummary } from '@/lib/types';

const DAY = 24 * 3_600_000;

export default function NewEventScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { isOwner } = useSession();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TmdbSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [details, setDetails] = useState<TmdbDetails | null>(null);
  const [poster, setPoster] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ownerNote, setOwnerNote] = useState('');
  const [deadline, setDeadline] = useState(new Date(Date.now() + 5 * DAY));
  const { busy, run } = useAction();

  // Search as Dino types, a beat after he stops.
  useEffect(() => {
    const text = query.trim();
    if (details || text.length < 2) {
      setResults(null);
      return;
    }
    let current = true;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await searchMovies(text);
        if (current) {
          setResults(found);
          setNote(null);
        }
      } catch (error) {
        if (current) setNote({ text: messageOf(error), tone: 'danger' });
      } finally {
        if (current) setSearching(false);
      }
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, details]);

  if (!isOwner) {
    return (
      <Screen edges={['top', 'bottom', 'left', 'right']}>
        <BackHeader />
        <EmptyState icon="🔒" title="Organizer only" />
      </Screen>
    );
  }

  const choose = (movie: TmdbSummary) =>
    run(`pick:${movie.tmdb_id}`, async () => {
      const loaded = await movieDetails(movie.tmdb_id);
      setDetails(loaded);
      setPoster(loaded.movie.poster_path ?? loaded.posters[0] ?? null);
      setBackdrop(loaded.movie.backdrop_path ?? loaded.backdrops[0] ?? null);
      setTitle('');
      setDescription('');
    });

  const create = () =>
    run('create', async () => {
      const eventId = await owner.createEvent({
        movie: { ...details!.movie },
        rsvpDeadline: deadline.toISOString(),
        posterPath: poster,
        backdropPath: backdrop,
        titleOverride: title.trim(),
        descriptionOverride: description.trim(),
        ownerNote: ownerNote.trim(),
      });
      // Home becomes the only history, so leaving the new event lands there, not back in this form.
      router.replace('/(tabs)' as Href);
      router.push(`/event/${eventId}` as Href);
      // Dino is not notified about his own night, so say where it went.
      try {
        const reach = await owner.reach();
        const missing = reach.not_signed_in;
        showAlert(
          'Movie night posted',
          `Sent to ${reach.phones} phone${reach.phones === 1 ? '' : 's'}.` +
            (missing.length
              ? ` ${missing.length} member${missing.length === 1 ? " hasn't" : "s haven't"} signed in yet, so they will only see it once they do: ${missing.join(', ')}.`
              : ' Everyone in the club is signed in.'),
        );
      } catch {
        // The night is posted; this is only the receipt.
      }
    });

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']}>
      <BackHeader title="New movie night" />

      {!details ? (
        <>
          <TextField label="Movie" value={query} onChangeText={setQuery} placeholder="Search TMDB" autoFocus autoCorrect={false} returnKeyType="search" />
          <StatusNote note={note} />
          {searching && <ActivityIndicator color={theme.accent} />}
          {results && results.length === 0 && !searching && <ThemedText themeColor="textSecondary">No movies found.</ThemedText>}
          {results && results.length > 0 && (
            <Card>
              {results.map((movie) => (
                <Row
                  key={movie.tmdb_id}
                  left={<Poster path={movie.poster_path} width={44} />}
                  title={movie.title}
                  subtitle={[movie.release_date?.slice(0, 4), movie.overview].filter(Boolean).join(' · ')}
                  right={busy === `pick:${movie.tmdb_id}` ? <ActivityIndicator color={theme.accent} /> : undefined}
                  onPress={() => void choose(movie)}
                />
              ))}
            </Card>
          )}
        </>
      ) : (
        <>
          <Card>
            <View style={styles.picked}>
              <Poster path={poster} width={84} />
              <View style={styles.pickedText}>
                <ThemedText type="cardTitle">{details.movie.title}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {[details.movie.release_date?.slice(0, 4), details.movie.runtime_minutes ? `${details.movie.runtime_minutes} min` : null].filter(Boolean).join(' · ')}
                </ThemedText>
                <Button title="Pick a different movie" size="sm" variant="secondary" onPress={() => setDetails(null)} />
              </View>
            </View>
          </Card>

          {details.posters.length > 1 && (
            <Card>
              <CardTitle title="Poster" icon="image-outline" />
              <ImageChoices paths={details.posters} selected={poster} onSelect={setPoster} width={78} height={117} size="w185" />
            </Card>
          )}
          {details.backdrops.length > 1 && (
            <Card>
              <CardTitle title="Backdrop" icon="images-outline" />
              <ImageChoices paths={details.backdrops} selected={backdrop} onSelect={setBackdrop} width={176} height={99} size="w342" />
            </Card>
          )}

          <Card>
            <CardTitle title="The invitation" icon="create-outline" />
            <TextField label="Title (optional)" value={title} onChangeText={setTitle} placeholder={details.movie.title} maxLength={200} hint="Leave empty to use the movie's title." />
            <TextField label="Description (optional)" value={description} onChangeText={setDescription} multiline maxLength={4000} placeholder={details.movie.overview ?? ''} hint="Leave empty to use TMDB's." />
            <TextField label="Dino's Note (optional)" value={ownerNote} onChangeText={setOwnerNote} multiline maxLength={2000} placeholder="Why this one, what to bring, where to meet." />
          </Card>

          <Card>
            <CardTitle title="RSVP deadline" icon="time-outline" />
            <DateTimeField value={deadline} onChange={setDeadline} hint="Members can change their answer until then. After it, no answer counts as Can't Go." />
            <ThemedText type="small" themeColor="textSecondary">
              Showtimes come next, on the event page. Voting can start while RSVP is still open.
            </ThemedText>
          </Card>

          <Button title="Create and notify everyone" icon="megaphone-outline" onPress={create} loading={busy === 'create'} disabled={deadline.getTime() <= Date.now()} />
        </>
      )}
    </Screen>
  );
}

function ImageChoices({
  paths, selected, onSelect, width, height, size,
}: {
  paths: string[];
  selected: string | null;
  onSelect: (path: string) => void;
  width: number;
  height: number;
  size: 'w185' | 'w342';
}) {
  const theme = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.images}>
      {paths.map((path) => {
        const uri = tmdbImage(path, size);
        if (!uri) return null;
        const on = path === selected;
        return (
          <Pressable key={path} onPress={() => onSelect(path)} accessibilityRole="imagebutton" accessibilityState={{ selected: on }}>
            <Image
              source={{ uri }}
              style={{ width, height, borderRadius: Radius.sm, borderWidth: on ? 3 : StyleSheet.hairlineWidth, borderColor: on ? theme.accent : theme.border, opacity: on ? 1 : 0.75 }}
              contentFit="cover"
              transition={150}
            />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  picked: { flexDirection: 'row', gap: Spacing.three },
  pickedText: { flex: 1, gap: Spacing.two, justifyContent: 'center' },
  images: { gap: Spacing.two },
});
