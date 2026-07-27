const labels = { image: "图片", video: "视频", audio: "音频" };

export function createMentionId(kind, sequence) {
  return `${labels[kind] || "素材"}${sequence}`;
}

export function mentionLabel(item) {
  return `${labels[item.kind] || "素材"}${item.sequence}`;
}

export function mentionToken(item) {
  return `@${item.mentionId}`;
}

export function insertMention(textarea, token) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const inserted = `${prefix}${token}${suffix}`;
  textarea.value = `${before}${inserted}${after}`;
  const cursor = start + inserted.length;
  textarea.focus();
  textarea.setSelectionRange(cursor, cursor);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
