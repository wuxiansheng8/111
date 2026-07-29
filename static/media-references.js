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

export function reindexMediaMentions(items, prompt, removedMentionId = "") {
  const counters = { image: 0, video: 0, audio: 0 };
  const replacements = new Map();
  const files = items.map((item) => {
    const sequence = ++counters[item.kind];
    const mentionId = createMentionId(item.kind, sequence);
    replacements.set(mentionToken(item), `@${mentionId}`);
    return { ...item, sequence, mentionId };
  });

  const removedToken = removedMentionId ? `@${removedMentionId}` : "";
  const text = String(prompt || "")
    .replace(/@(图片|视频|音频)\d+/g, (token) => {
      if (token === removedToken) return "";
      return replacements.get(token) || token;
    })
    .replace(/[ \t]{2,}/g, " ");

  return { files, prompt: text };
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
