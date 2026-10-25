/** Pure field classification shared by server redaction and local review previews. */
export const isSensitiveField = (key: string) =>
  /authorization|cookie|token|secret|password|passwd|api.?key|credential|session/i.test(
    key,
  );
