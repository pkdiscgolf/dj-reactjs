const Auth0 = require("auth0");
const JwksClient = require("jwks-rsa");
const jwt = require("jsonwebtoken");

// Management client for interacting with Auth0 API
const managementClient = new Auth0.ManagementClient({
  domain: process.env.AUTH0_DOMAIN,
  clientId: process.env.AUTH0_MANAGEMENT_CLIENT_ID,
  clientSecret: process.env.AUTH0_MANAGEMENT_CLIENT_SECRET,
});

const jwksClient = JwksClient({
  jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
});

// Verify and decode access token
async function verifyAccessToken(token) {
  const decoded = jwt.decode(token, { complete: true });

  if (!decoded) {
    throw new Error("Could not decode access token");
  }

  const key = await jwksClient.getSigningKey(decoded.header.kid);

  return jwt.verify(token, key.getPublicKey(), {
    algorithms: ["RS256"],
    audience: `https://${process.env.AUTH0_DOMAIN}/api/v2/`,
    issuer: `https://${process.env.AUTH0_DOMAIN}/`,
  });
}

module.exports = {
  managementClient,
  verifyAccessToken,
};
