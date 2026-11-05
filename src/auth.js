import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError } from './errors.js';

// Verifies a Cloudflare Access assertion: signature (JWKS, refreshed on unknown kid), issuer,
// audience and expiry. `jwks` is injectable for tests; production uses the team's remote set.
export function makeVerifier({ teamDomain, audience, jwks }) {
  const issuer = `https://${teamDomain}`;
  const keys = jwks || createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256', 'ES256'] });
    return payload;
  };
}

// Returns async (req) => user id. The user comes only from the verified token.
export function makeAuthenticator({ verify, users }) {
  return async (req) => {
    const token = req.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token === '') throw new HttpError(401, 'unauthorized');
    let payload;
    try {
      payload = await verify(token);
    } catch {
      throw new HttpError(401, 'unauthorized');
    }
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const user = users.get(email);
    if (!user) throw new HttpError(403, 'forbidden');
    return user;
  };
}
