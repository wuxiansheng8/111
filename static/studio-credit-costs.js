const IMAGE_CREDITS = {
  "nano-banana2": {
    resolution: { "1K": 0, "2K": 0, "4K": 30 },
  },
  "gpt-image2": {
    quality: { low: 0, medium: 0, high: 80 },
  },
};

const SEEDANCE_RATES = {
  "seedance-standard": { "720p": 90, "1080p": 180 },
  "seedance-fast": { "720p": 50 },
};

const KLING_RATES = {
  "720p": { silent: 20, audio: 25 },
  "1080p": { silent: 25, audio: 35 },
};

export function estimateCreditCost({
  mediaType,
  model,
  resolution,
  quality,
  duration,
  generateAudio,
}) {
  if (mediaType === "image") {
    const pricing = IMAGE_CREDITS[model];
    return pricing?.resolution?.[resolution]
      ?? pricing?.quality?.[quality]
      ?? null;
  }

  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const seedanceRate = SEEDANCE_RATES[model]?.[resolution];
  if (seedanceRate != null) return seedanceRate * seconds;

  if (model === "kling3" || model === "kling-o3") {
    const audioMode = generateAudio ? "audio" : "silent";
    const klingRate = KLING_RATES[resolution]?.[audioMode];
    return klingRate == null ? null : klingRate * seconds;
  }

  return null;
}
