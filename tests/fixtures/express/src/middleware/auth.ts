// @ts-nocheck
export function authenticate(_req, _res, next) {
  return next();
}

export function requireAuth(_req, _res, next) {
  return next();
}

export function verifyToken(_req, _res, next) {
  return next();
}

export function authorize(_role) {
  return (_req, _res, next) => next();
}

export default function authMiddleware(_req, _res, next) {
  return next();
}
