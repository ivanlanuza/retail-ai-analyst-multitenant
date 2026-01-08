export function getRequestContext(req) {
  if (!req.__ctx) {
    req.__ctx = {};
  }
  return req.__ctx;
}
