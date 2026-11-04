// POST /functions/v1/invite-preview
// Step 1 of invite sign-in: shows whose invite a code is. See
// ../_shared/invite-gateway.ts for the request and response shapes.
import { serveInviteEndpoint } from '../_shared/edge.ts';
import { handleInvitePreview } from '../_shared/invite-gateway.ts';

export default serveInviteEndpoint('invite-preview', handleInvitePreview);
