// POST /functions/v1/owner-members
// Dino creates a member with their invite, or issues a new (or recovery)
// invite for an existing member. Returns the invite code once. See
// ../_shared/owner-invites.ts for the request and response shapes.
import { serveOwnerEndpoint } from '../_shared/edge.ts';
import { handleOwnerMembers } from '../_shared/owner-invites.ts';

export default serveOwnerEndpoint('owner-members', handleOwnerMembers);
