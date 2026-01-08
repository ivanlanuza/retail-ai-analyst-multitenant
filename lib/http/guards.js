export function requirePost(req, streamError) {
  if (req.method !== "POST") {
    streamError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return false;
  }
  return true;
}
