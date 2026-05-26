// Voice quality detection — figures out whether the macOS user has
// installed a high-quality Siri / Premium / Enhanced Chinese voice, and
// lists the Chinese voices that are usable in the picker.
//
// macOS ships only compact-quality Tingting / Sinji / Meijia out of the box;
// the natural-sounding voices (Siri "Voice 1/2/3/4", Premium, Enhanced) have
// to be downloaded through System Settings → Accessibility → Spoken Content
// → System Voices. We can detect the result but not trigger the download.

export type VoiceTier = 'siri' | 'premium' | 'enhanced' | 'neural' | 'default';

export type VoiceLocale = 'mandarin' | 'traditional' | 'cantonese';

function getLocale(voice: SpeechSynthesisVoice): VoiceLocale | null {
  const lang = voice.lang?.toLowerCase() ?? '';
  // Cantonese: yue*, zh-HK, zh-yue
  if (lang.startsWith('yue') || lang.includes('-hk') || lang.includes('-yue')) {
    return 'cantonese';
  }
  // Traditional Mandarin (Taiwan): zh-TW, cmn-Hant-*
  if (lang.includes('-tw') || lang.includes('hant')) {
    return 'traditional';
  }
  // Mainland Mandarin: zh-CN, cmn*, generic zh
  if (lang.startsWith('zh') || lang.startsWith('cmn')) {
    return 'mandarin';
  }
  return null;
}

function isChinese(voice: SpeechSynthesisVoice): boolean {
  return getLocale(voice) !== null;
}

function isChineseMandarin(voice: SpeechSynthesisVoice): boolean {
  return getLocale(voice) === 'mandarin';
}

// Classify a voice into a tier we can show in the UI.
export function classifyVoice(voice: SpeechSynthesisVoice): VoiceTier {
  const name = voice.name.toLowerCase();
  // Siri "Voice 1/2/3/4" voices show up with names like "Siri Voice 2"
  // (English locales) or just "Voice 2" / "语音 2" (zh-CN). Matching both.
  if (name.includes('siri') || /\bvoice\s*[1-4]\b/.test(name) || /语音\s*[1-4]/.test(voice.name)) {
    return 'siri';
  }
  if (name.includes('premium')) return 'premium';
  if (name.includes('enhanced')) return 'enhanced';
  if (name.includes('neural')) return 'neural';
  return 'default';
}

// "Premium-grade" = anything noticeably better than the default compact
// voice. If none of these are present we'll nudge the user to install one.
// Kept Mandarin-only on purpose: the download guide steers users toward
// Mandarin voices, so having a fancy Cantonese voice shouldn't suppress it.
export function isPremiumChineseVoice(voice: SpeechSynthesisVoice): boolean {
  if (!isChineseMandarin(voice)) return false;
  const tier = classifyVoice(voice);
  return tier !== 'default';
}

export function hasPremiumChineseVoice(voices: SpeechSynthesisVoice[]): boolean {
  return voices.some(isPremiumChineseVoice);
}

export interface ListedVoice {
  voice: SpeechSynthesisVoice;
  // Display name — falls back to voice.name. Locale label is appended by UI.
  label: string;
  tier: VoiceTier;
  locale: VoiceLocale;
  localeLabel: string;
  isDefault: boolean;
}

const TIER_ORDER: Record<VoiceTier, number> = {
  siri: 0,
  premium: 1,
  enhanced: 2,
  neural: 3,
  default: 4,
};

const LOCALE_ORDER: Record<VoiceLocale, number> = {
  mandarin: 0,
  traditional: 1,
  cantonese: 2,
};

export function localeLabel(locale: VoiceLocale): string {
  switch (locale) {
    case 'mandarin':
      return '普通话';
    case 'traditional':
      return '繁体';
    case 'cantonese':
      return '粤语';
  }
}

// Returns Chinese voices sorted best-first, suitable for the voice-picker
// dropdown. Includes Mandarin, Traditional, and Cantonese — the UI tags
// each entry with a locale label so users can tell them apart.
export function listChineseVoices(voices: SpeechSynthesisVoice[]): ListedVoice[] {
  return voices
    .filter(isChinese)
    .map((voice) => {
      const tier = classifyVoice(voice);
      const locale = getLocale(voice)!;
      return {
        voice,
        label: voice.name,
        tier,
        locale,
        localeLabel: localeLabel(locale),
        isDefault: voice.default,
      };
    })
    .sort((a, b) => {
      const l = LOCALE_ORDER[a.locale] - LOCALE_ORDER[b.locale];
      if (l !== 0) return l;
      const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
      if (t !== 0) return t;
      return a.label.localeCompare(b.label);
    });
}

export function tierLabel(tier: VoiceTier): string {
  switch (tier) {
    case 'siri':
      return 'Siri';
    case 'premium':
      return 'Premium';
    case 'enhanced':
      return 'Enhanced';
    case 'neural':
      return 'Neural';
    case 'default':
      return 'Default';
  }
}
