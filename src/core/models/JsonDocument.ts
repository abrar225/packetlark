/** Parser diagnostics must never quote credential-bearing input contents. */
export function parseJsonDocument(text: string, label: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Malformed JSON in ${label} input; repair the document before retrying.`,
    );
  }
}
