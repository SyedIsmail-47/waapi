/** Shared pino redact paths — never log secrets, tokens, or message bodies. */
export const PINO_REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "req.headers['x-csrf-token']",
  "req.headers['x-admin-secret']",
  "res.headers['set-cookie']",
  "authorization",
  "cookie",
  "token",
  "password",
  "accessToken",
  "refreshToken",
  "text",
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.password",
  "*.accessToken",
  "*.refreshToken",
  "*.text",
  "body.text",
  "body.password",
  "body.token",
  "body.currentPassword",
  "body.newPassword",
];

export const defaultPinoRedact = {
  paths: PINO_REDACT_PATHS,
  censor: "[Redacted]",
};
