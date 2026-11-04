// TEST ONLY. Stands in for Hanko in end-to-end tests, which can't receive sign-in e-mails.
// It signs real RS256 tokens that the backend validates through the normal JWKS path.
// Used only by e2e/compose.e2e.yaml, and must never be part of a real deployment.
import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyId = "e2e";
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signToken(subject, email, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: subject,
    iat: now,
    exp: now + expiresIn,
    aud: ["localhost"],
    session_id: randomUUID(),
    email: { address: email, is_primary: true, is_verified: true },
  };
  const unsigned = `${b64({ alg: "RS256", typ: "JWT", kid: keyId })}.${b64(claims)}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function claimsOf(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
}

function send(req, res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": req.headers.origin ?? "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization,content-type,x-language",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "x-auth-token,x-session-lifetime,x-session-retention",
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function bearer(req) {
  const fromHeader = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const fromCookie = /(?:^|;\s*)hanko=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  return fromHeader ?? fromCookie ?? null;
}

createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (req.method === "OPTIONS") return send(req, res, 204);
    if (path === "/.well-known/jwks.json") {
      return send(req, res, 200, {
        keys: [{ ...publicKey.export({ format: "jwk" }), kid: keyId, use: "sig", alg: "RS256" }],
      });
    }
    if (path === "/test/token" && req.method === "POST") {
      const { email, expiresIn } = JSON.parse(raw);
      const subject = createHash("sha256").update(email).digest("hex").slice(0, 32);
      return send(req, res, 200, { token: signToken(subject, email, expiresIn) });
    }
    if (path === "/sessions/validate") {
      const claims = bearer(req) && claimsOf(bearer(req));
      if (!claims || claims.exp * 1000 < Date.now()) return send(req, res, 200, { is_valid: false });
      return send(req, res, 200, {
        is_valid: true,
        claims: {
          ...claims,
          subject: claims.sub,
          expiration: new Date(claims.exp * 1000).toISOString(),
          issued_at: new Date(claims.iat * 1000).toISOString(),
        },
        expiration_time: new Date(claims.exp * 1000).toISOString(),
        user_id: claims.sub,
      });
    }
    if (path === "/logout") return send(req, res, 204);
    if (path === "/me") return send(req, res, 200, { id: claimsOf(bearer(req) ?? "")?.sub });
    return send(req, res, 404, { code: 404, message: "Not found in mock Hanko" });
  });
}).listen(4000, () => console.log("mock Hanko on :4000"));
