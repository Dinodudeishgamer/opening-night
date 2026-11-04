// POST /functions/v1/owner-bootstrap
// TEMPORARY. Creates Dino's owner row and first invite. Deployed, called and
// deleted again by scripts/owner-bootstrap.mjs; it is not part of the normal
// function set and must not stay deployed. Callable only with the project's
// secret key, and the database function behind it revokes itself at the
// owner's first sign-in. See ../_shared/owner-invites.ts.
import { serveSecretEndpoint } from '../_shared/edge.ts';
import { handleOwnerBootstrap } from '../_shared/owner-invites.ts';

export default serveSecretEndpoint('owner-bootstrap', handleOwnerBootstrap);
