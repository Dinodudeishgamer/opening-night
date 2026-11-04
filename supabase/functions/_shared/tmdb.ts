// TMDB proxy: the logic behind the tmdb Edge Function.
//
// The TMDB credential is an Edge Function secret (TMDB_API_KEY). It never
// reaches the app: Dino's phone asks this function, and this function asks
// TMDB. Only the owner creates events, so only the owner may search; that is
// decided by asking the database who the caller is (whoami, with the
// caller's own session), not by anything in the request.
//
// Runtime-agnostic like the other shared modules: Web APIs only, everything
// else through TmdbDeps.

export const TMDB_SECRET_NAME = 'TMDB_API_KEY';

export interface TmdbDeps {
  /** Calls a public database function as the signed-in caller. */
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  fetch: typeof fetch;
  /** A TMDB v3 API key or a v4 read access token. */
  apiKey: string | undefined;
  log?: (event: string) => void;
}

const API = 'https://api.themoviedb.org/3';
const MAX_BODY_BYTES = 512;
const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 12;
const MAX_IMAGES = 12;
const PATH_PATTERN = /^\/[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|png|webp)$/;

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const invalidRequest = () => respond(400, { outcome: 'invalid_request' });
const serverError = () => respond(500, { outcome: 'server_error' });

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const path = (value: unknown): string | null => (typeof value === 'string' && PATH_PATTERN.test(value) ? value : null);
const date = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

// A v4 read token is a JWT and goes in a header; a v3 key is a query parameter.
async function tmdb(deps: TmdbDeps, pathname: string, params: Record<string, string>): Promise<Record<string, unknown> | null> {
  const key = deps.apiKey as string;
  const url = new URL(API + pathname);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  const response = await deps.fetch(url, { headers });
  if (!response.ok) {
    deps.log?.(response.status === 401 ? 'tmdb_unauthorized' : 'tmdb_error');
    return null;
  }
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

function summary(movie: Record<string, unknown>) {
  return {
    tmdb_id: movie.id,
    title: text(movie.title) ?? 'Untitled',
    release_date: date(movie.release_date),
    overview: text(movie.overview),
    poster_path: path(movie.poster_path),
    backdrop_path: path(movie.backdrop_path),
  };
}

function imagePaths(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const paths: string[] = [];
  for (const image of list) {
    const p = path((image as { file_path?: unknown })?.file_path);
    if (p && !paths.includes(p)) paths.push(p);
    if (paths.length === MAX_IMAGES) break;
  }
  return paths;
}

/**
 * The YouTube id of the film's trailer, if TMDB lists one: an official
 * trailer before any other, a trailer before a teaser. Only the id is kept,
 * and only if it looks like one; the app builds the link itself.
 */
function trailerKey(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const rank = (video: Record<string, unknown>) => (video.type === 'Trailer' ? 2 : 0) + (video.official === true ? 1 : 0);
  const candidates = list
    .filter((video): video is Record<string, unknown> => typeof video === 'object' && video !== null)
    .filter((video) => video.site === 'YouTube' && (video.type === 'Trailer' || video.type === 'Teaser'))
    .filter((video) => typeof video.key === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(video.key))
    .sort((a, b) => rank(b) - rank(a));
  return candidates.length ? (candidates[0].key as string) : null;
}

/**
 * POST, as the signed-in owner:
 *   { action: 'search', query }
 *       -> 200 { outcome: 'ok', results: [{ tmdb_id, title, release_date, overview, poster_path, backdrop_path }] }
 *   { action: 'details', tmdb_id }
 *       -> 200 { outcome: 'ok', movie: { ...summary, runtime_minutes, metadata }, posters: [path], backdrops: [path] }
 *   400 invalid_request | 403 forbidden | 404 not_found | 500 server_error | 503 not_configured
 */
export async function handleTmdb(req: Request, deps: TmdbDeps): Promise<Response> {
  try {
    if (req.method !== 'POST') return respond(405, { outcome: 'method_not_allowed' });
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return invalidRequest();
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return invalidRequest();
      body = parsed as Record<string, unknown>;
    } catch {
      return invalidRequest();
    }

    const who = await deps.rpc('whoami', {});
    if (who.error) {
      deps.log?.('backend_error');
      return serverError();
    }
    if ((who.data as { role?: unknown } | null)?.role !== 'owner') return respond(403, { outcome: 'forbidden' });

    if (typeof deps.apiKey !== 'string' || deps.apiKey.length < 16) {
      deps.log?.('not_configured');
      return respond(503, { outcome: 'not_configured' });
    }

    if (body.action === 'search') {
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (query.length < 1 || query.length > MAX_QUERY_LENGTH) return invalidRequest();
      const data = await tmdb(deps, '/search/movie', { query, include_adult: 'false', language: 'en-US', page: '1' });
      if (!data) return serverError();
      const results = Array.isArray(data.results) ? data.results : [];
      return respond(200, {
        outcome: 'ok',
        results: results
          .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && Number.isInteger((m as { id?: unknown }).id))
          .slice(0, MAX_RESULTS)
          .map(summary),
      });
    }

    if (body.action === 'details') {
      if (!Number.isInteger(body.tmdb_id) || (body.tmdb_id as number) <= 0) return invalidRequest();
      const data = await tmdb(deps, `/movie/${body.tmdb_id}`, {
        language: 'en-US',
        append_to_response: 'images,videos',
        include_image_language: 'en,null',
      });
      if (!data) return respond(404, { outcome: 'not_found' });
      const images = (data.images ?? {}) as { posters?: unknown; backdrops?: unknown };
      const base = summary(data);
      const posters = imagePaths(images.posters);
      const backdrops = imagePaths(images.backdrops);
      if (base.poster_path && !posters.includes(base.poster_path)) posters.unshift(base.poster_path);
      if (base.backdrop_path && !backdrops.includes(base.backdrop_path)) backdrops.unshift(base.backdrop_path);
      return respond(200, {
        outcome: 'ok',
        movie: {
          ...base,
          runtime_minutes: Number.isInteger(data.runtime) && (data.runtime as number) > 0 ? data.runtime : null,
          metadata: {
            tagline: text(data.tagline),
            genres: Array.isArray(data.genres)
              ? data.genres.map((g) => text((g as { name?: unknown })?.name)).filter((g): g is string => g !== null)
              : [],
            original_language: text(data.original_language),
            trailer_key: trailerKey((data.videos as { results?: unknown } | undefined)?.results),
          },
        },
        posters,
        backdrops,
      });
    }

    return invalidRequest();
  } catch {
    deps.log?.('unhandled_error');
    return serverError();
  }
}
