export const modelProfiles = {
  "seedance-standard": {
    label: "Seedance 2.0 标准版",
    prefix: "firefly-seedance2",
    durations: Array.from({ length: 12 }, (_, index) => index + 4),
    resolution: "720p",
    supportsMedia: true,
    supportsNegativePrompt: true,
    limits: { image: 9, video: 3, audio: 3, total: 12 },
  },
  "seedance-fast": {
    label: "Seedance 2.0 Fast",
    prefix: "firefly-seedance2-fast",
    durations: Array.from({ length: 12 }, (_, index) => index + 4),
    resolution: "720p",
    supportsMedia: true,
    supportsNegativePrompt: true,
    limits: { image: 9, video: 3, audio: 3, total: 12 },
  },
  kling3: {
    label: "Kling 3.0",
    prefix: "firefly-kling3",
    durations: [5, 10, 15],
    resolution: "720p",
    supportsMedia: false,
    supportsNegativePrompt: false,
    limits: { image: 2, video: 0, audio: 0, total: 2 },
  },
  "kling-o3": {
    label: "Kling 3.0 Omni",
    prefix: "firefly-kling-o3",
    durations: [5, 15],
    resolution: "1080p",
    supportsMedia: false,
    supportsNegativePrompt: false,
    limits: { image: 2, video: 0, audio: 0, total: 2 },
  },
};

export const sizeLimits = {
  image: 10 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
};

export function taskModelSummary(model) {
  const profiles = Object.values(modelProfiles).sort((a, b) => b.prefix.length - a.prefix.length);
  const profile = profiles.find((item) => String(model || "").startsWith(`${item.prefix}-`));
  if (!profile) return String(model || "未知模型");
  const suffix = String(model).slice(profile.prefix.length + 1);
  const match = suffix.match(/^(\d+)s-(\d+)x(\d+)$/);
  return match ? `${profile.label} · ${match[1]} 秒 · ${match[2]}:${match[3]}` : profile.label;
}
