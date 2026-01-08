//Convert LangChain message content to a string. This function MUST always return a string.
export function contentToString(content) {
  if (content == null) return "";

  // Already a string
  if (typeof content === "string") {
    return content;
  }

  // Array of content blocks (common in LangChain)
  if (Array.isArray(content)) {
    return content
      .map((part) => contentToString(part))
      .join(" ")
      .trim();
  }

  // Object with text field
  if (typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text;
    }

    // Fallback: stringify safely
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }

  // Final fallback
  return "";
}
