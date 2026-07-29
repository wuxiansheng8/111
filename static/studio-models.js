export const videoModelProfiles = {
  "seedance-standard": {
    label: "Seedance 2.0 标准版",
    prefix: "firefly-seedance2",
    durations: Array.from({ length: 12 }, (_, index) => index + 4),
    ratios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    implicitResolution: "720p",
    supportsMedia: true,
    supportsNegativePrompt: true,
    limits: { image: 9, video: 3, audio: 3, total: 12 },
  },
  "seedance-fast": {
    label: "Seedance 2.0 Fast",
    prefix: "firefly-seedance2-fast",
    durations: Array.from({ length: 12 }, (_, index) => index + 4),
    ratios: ["16:9", "9:16"],
    resolutions: ["720p"],
    implicitResolution: "720p",
    supportsMedia: true,
    supportsNegativePrompt: true,
    limits: { image: 9, video: 3, audio: 3, total: 12 },
  },
  kling3: {
    label: "Kling 3.0",
    prefix: "firefly-kling3",
    durations: Array.from({ length: 13 }, (_, index) => index + 3),
    ratios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    implicitResolution: "720p",
    referenceModes: ["frame"],
    supportsMedia: false,
    supportsNegativePrompt: false,
    limits: { image: 2, video: 0, audio: 0, total: 2 },
  },
  "kling-o3": {
    label: "Kling 3.0 Omni",
    prefix: "firefly-kling-o3",
    durations: Array.from({ length: 13 }, (_, index) => index + 3),
    ratios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    implicitResolution: "1080p",
    referenceModes: ["frame", "image"],
    supportsMedia: false,
    supportsNegativePrompt: false,
    limits: { image: 2, video: 0, audio: 0, total: 2 },
    limitsByReferenceMode: {
      frame: { image: 2, video: 0, audio: 0, total: 2 },
      image: { image: 3, video: 0, audio: 0, total: 3 },
    },
  },
};

export const imageModelProfiles = {
  "nano-banana2": {
    label: "Nano Banana 2",
    prefix: "firefly-nano-banana2",
    resolutions: ["1K", "2K", "4K"],
    ratios: [
      "auto", "1:1", "21:9", "16:9", "3:2", "4:3", "5:4", "4:5",
      "3:4", "2:3", "9:16", "8:1", "4:1", "1:4", "1:8",
    ],
    qualities: [],
    supportsGroundSearch: true,
    supportsMedia: false,
    supportsNegativePrompt: false,
    limits: { image: 6, video: 0, audio: 0, total: 6 },
  },
  "gpt-image2": {
    label: "GPT Image 2",
    prefix: "firefly-gpt-image",
    resolutions: ["1K", "2K", "4K"],
    ratios: ["auto", "1:1", "21:9", "16:9", "3:2", "4:3", "5:4", "4:5", "3:4", "2:3", "9:16"],
    qualities: ["low", "medium", "high"],
    supportsGroundSearch: false,
    defaultQuality: "medium",
    supportsMedia: false,
    supportsNegativePrompt: false,
    limits: { image: 6, video: 0, audio: 0, total: 6 },
  },
};

export const modelProfiles = {
  image: imageModelProfiles,
  video: videoModelProfiles,
};

export const sizeLimits = {
  image: 10 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
};

export function buildModelId(mediaType, profile, state) {
  const ratioSuffix = state.ratio.replace(":", "x");
  if (mediaType === "image") {
    return `${profile.prefix}-${state.resolution.toLowerCase()}-${ratioSuffix}`;
  }
  const resolutionSuffix = state.resolution !== profile.implicitResolution
    ? `-${state.resolution}`
    : "";
  return `${profile.prefix}-${state.duration}s-${ratioSuffix}${resolutionSuffix}`;
}

export function taskModelSummary(model) {
  const value = String(model || "");
  const images = Object.values(imageModelProfiles).sort((a, b) => b.prefix.length - a.prefix.length);
  const imageProfile = images.find((item) => value.startsWith(`${item.prefix}-`));
  if (imageProfile) {
    const suffix = value.slice(imageProfile.prefix.length + 1);
    const match = suffix.match(/^(1k|2k|4k)-(auto|(\d+)x(\d+))$/i);
    if (!match) return imageProfile.label;
    const ratio = match[2].toLowerCase() === "auto" ? "自动" : `${match[3]}:${match[4]}`;
    return `${imageProfile.label} · ${match[1].toUpperCase()} · ${ratio}`;
  }

  const videos = Object.values(videoModelProfiles).sort((a, b) => b.prefix.length - a.prefix.length);
  const videoProfile = videos.find((item) => value.startsWith(`${item.prefix}-`));
  if (!videoProfile) return value || "未知模型";
  const suffix = value.slice(videoProfile.prefix.length + 1);
  const match = suffix.match(/^(\d+)s-(\d+)x(\d+)(?:-(\d+p))?$/);
  if (!match) return videoProfile.label;
  const resolution = match[4] || videoProfile.implicitResolution || videoProfile.resolutions[0];
  return `${videoProfile.label} · ${match[1]} 秒 · ${match[2]}:${match[3]} · ${resolution}`;
}
