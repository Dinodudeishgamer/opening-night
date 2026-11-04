// The notification dispatcher: the only code that talks to the push
// provider. It runs server-side on a schedule (see the notifications
// migration), is callable only with the project's secret key, and decides
// nothing itself: what to send, to whom, and when is all decided in the
// database. It claims queued work, hands it to the provider, and reports
// what happened.
//
// Only Web APIs are used and everything from the platform comes in through
// DispatchDeps, so the same code runs in the Edge runtime and under the Node
// test runner.
//
// Tokens and message text are never logged.

export type RpcResult = { data: unknown; error: unknown };

export interface DispatchDeps {
  /** Calls a public database function as service_role. */
  rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
  /** Outbound HTTP; the platform's fetch. */
  fetch: typeof fetch;
  /** Optional Expo access token (only needed if enhanced push security is on). */
  expoAccessToken?: string;
  /** Fixed event names only. */
  log?: (event: string) => void;
}

const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const BATCH = 100;
const MAX_BATCHES = 5;
// Provider errors that mean the device will never accept a push again.
const DEAD_TOKEN_ERRORS = new Set(['DeviceNotRegistered']);

interface PushJob {
  delivery_id: string;
  token: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  priority: string;
}
interface ReceiptJob {
  delivery_id: string;
  ticket_id: string;
}
type Result = Record<string, string>;

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function providerError(value: unknown): string {
  const text = typeof value === 'string' ? value : 'unknown';
  // A provider's error code, never its free text (which can echo a token).
  return /^[A-Za-z0-9_]{1,60}$/.test(text) ? text : 'provider_error';
}

function expoHeaders(deps: DispatchDeps): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (deps.expoAccessToken) headers.authorization = `Bearer ${deps.expoAccessToken}`;
  return headers;
}

async function sendPush(jobs: PushJob[], deps: DispatchDeps): Promise<Result[]> {
  if (jobs.length === 0) return [];
  const failAll = (error: string) => jobs.map((job) => ({ delivery_id: job.delivery_id, status: 'failed', error }));
  try {
    const response = await deps.fetch(EXPO_SEND_URL, {
      method: 'POST',
      headers: expoHeaders(deps),
      body: JSON.stringify(
        jobs.map((job) => ({
          to: job.token,
          title: job.title,
          body: job.body ?? undefined,
          data: job.data,
          sound: 'default',
          priority: job.priority === 'high' ? 'high' : 'default',
          channelId: job.priority === 'high' ? 'urgent' : 'default',
        })),
      ),
    });
    if (!response.ok) return failAll(`http_${response.status}`);
    const payload = (await response.json()) as { data?: unknown };
    if (!Array.isArray(payload.data) || payload.data.length !== jobs.length) return failAll('bad_response');
    return jobs.map((job, i) => {
      const ticket = payload.data![i] as { status?: string; id?: string; details?: { error?: string } };
      if (ticket?.status === 'ok' && typeof ticket.id === 'string') {
        return { delivery_id: job.delivery_id, status: 'sent', ticket_id: ticket.id };
      }
      const error = providerError(ticket?.details?.error);
      return { delivery_id: job.delivery_id, status: DEAD_TOKEN_ERRORS.has(error) ? 'dead' : 'failed', error };
    });
  } catch {
    return failAll('network');
  }
}

async function checkReceipts(jobs: ReceiptJob[], deps: DispatchDeps): Promise<Result[]> {
  if (jobs.length === 0) return [];
  try {
    const response = await deps.fetch(EXPO_RECEIPTS_URL, {
      method: 'POST',
      headers: expoHeaders(deps),
      body: JSON.stringify({ ids: jobs.map((job) => job.ticket_id) }),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: Record<string, { status?: string; details?: { error?: string } }> };
    const receipts = payload.data ?? {};
    const results: Result[] = [];
    for (const job of jobs) {
      const receipt = receipts[job.ticket_id];
      // Not ready yet: leave it unchecked and ask again next run.
      if (!receipt) continue;
      if (receipt.status === 'ok') {
        results.push({ delivery_id: job.delivery_id, status: 'ok' });
      } else {
        const error = providerError(receipt.details?.error);
        results.push({ delivery_id: job.delivery_id, status: DEAD_TOKEN_ERRORS.has(error) ? 'dead' : 'error', error });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * POST {} with the project's secret key.
 *   200 { outcome: 'ok', pushed, failed, receipts }   counts only
 *   405 method_not_allowed | 500 server_error
 */
export async function handleDispatch(req: Request, deps: DispatchDeps): Promise<Response> {
  if (req.method !== 'POST') return respond(405, { outcome: 'method_not_allowed' });
  const totals = { pushed: 0, failed: 0, receipts: 0 };
  try {
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const claim = await deps.rpc('dispatch_claim', { p_limit: BATCH });
      const work = claim.data as { push?: PushJob[]; receipts?: ReceiptJob[] } | null;
      if (claim.error || !work || !Array.isArray(work.push)) {
        deps.log?.('claim_failed');
        return respond(500, { outcome: 'server_error' });
      }
      const push = await sendPush(work.push, deps);
      const receipts = await checkReceipts(work.receipts ?? [], deps);

      if (push.length + receipts.length > 0) {
        const report = await deps.rpc('dispatch_report', { p_results: { push, receipts } });
        if (report.error) {
          // The messages may have gone out; the claim expires and they would
          // be retried. Stop rather than risk sending a second batch blind.
          deps.log?.('report_failed');
          return respond(500, { outcome: 'server_error' });
        }
      }
      totals.pushed += push.filter((r) => r.status === 'sent').length;
      totals.failed += push.filter((r) => r.status !== 'sent').length;
      totals.receipts += receipts.length;
      if (work.push.length < BATCH) break;
    }
    return respond(200, { outcome: 'ok', ...totals });
  } catch {
    deps.log?.('unhandled_error');
    return respond(500, { outcome: 'server_error' });
  }
}
