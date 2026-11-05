import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, createLocalJWKSet, exportJWK } from 'jose';
import { makeVerifier, makeAuthenticator } from '../src/auth.js';
import { HttpError } from '../src/errors.js';

const TEAM = 'example-team.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const users = new Map([
  ['a@example.com', 'alice'],
  ['b@example.com', 'bob'],
]);

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const authenticate = makeAuthenticator({
    verify: makeVerifier({ teamDomain: TEAM, audience: AUD, jwks }),
    users,
  });
  const sign = (claims = {}, { iss = `https://${TEAM}`, aud = AUD, exp = '5m', key = privateKey } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key);
  return { authenticate, sign };
}

const req = (token) => ({ headers: token === undefined ? {} : { 'cf-access-jwt-assertion': token } });
const status = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof HttpError);
    return e.status;
  }
  return 200;
};

test('valid token maps the email to a user, case-insensitively', async () => {
  const { authenticate, sign } = await setup();
  assert.equal(await authenticate(req(await sign({ email: 'A@Example.com' }))), 'alice');
  assert.equal(await authenticate(req(await sign({ email: 'b@example.com' }))), 'bob');
});

test('missing or garbage token is 401', async () => {
  const { authenticate } = await setup();
  assert.equal(await status(authenticate(req())), 401);
  assert.equal(await status(authenticate(req(''))), 401);
  assert.equal(await status(authenticate(req('not.a.jwt'))), 401);
});

test('wrong audience, issuer, signature or expiry is 401', async () => {
  const { authenticate, sign } = await setup();
  const claims = { email: 'a@example.com' };
  assert.equal(await status(authenticate(req(await sign(claims, { aud: 'other' })))), 401);
  assert.equal(await status(authenticate(req(await sign(claims, { iss: 'https://evil.example.com' })))), 401);
  assert.equal(
    await status(authenticate(req(await sign(claims, { exp: Math.floor(Date.now() / 1000) - 60 })))),
    401,
  );
  const other = await generateKeyPair('RS256');
  assert.equal(await status(authenticate(req(await sign(claims, { key: other.privateKey })))), 401);
});

test('valid token with unmapped or missing email is 403', async () => {
  const { authenticate, sign } = await setup();
  assert.equal(await status(authenticate(req(await sign({ email: 'x@example.com' })))), 403);
  assert.equal(await status(authenticate(req(await sign({})))), 403);
});

test('user fields in the request cannot influence identity', async () => {
  const { authenticate, sign } = await setup();
  const r = req(await sign({ email: 'a@example.com' }));
  r.headers['x-user'] = 'bob';
  r.url = '/api/conversations?user=bob';
  assert.equal(await authenticate(r), 'alice');
});
