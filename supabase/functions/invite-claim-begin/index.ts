// POST /functions/v1/invite-claim-begin
// Step 2 of invite sign-in: exchanges a valid invite code for the one-time
// claim ticket the client signs in with. See ../_shared/invite-gateway.ts for
// the request and response shapes.
import { serveInviteEndpoint } from '../_shared/edge.ts';
import { handleInviteClaimBegin } from '../_shared/invite-gateway.ts';

export default serveInviteEndpoint('invite-claim-begin', handleInviteClaimBegin);
