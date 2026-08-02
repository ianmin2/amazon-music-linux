/**
 * Shared constants. Main-process only — do not import this from a sandboxed
 * preload script, which cannot resolve relative requires.
 */

export const APP_NAME = "Amazon Music";

/** Storefronts, keyed by the suffix in `music.amazon.<id>`. */
export const REGIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "com", label: "United States (music.amazon.com)" },
  { id: "co.uk", label: "United Kingdom (music.amazon.co.uk)" },
  { id: "de", label: "Germany (music.amazon.de)" },
  { id: "fr", label: "France (music.amazon.fr)" },
  { id: "it", label: "Italy (music.amazon.it)" },
  { id: "es", label: "Spain (music.amazon.es)" },
  { id: "nl", label: "Netherlands (music.amazon.nl)" },
  { id: "ca", label: "Canada (music.amazon.ca)" },
  { id: "com.mx", label: "Mexico (music.amazon.com.mx)" },
  { id: "com.br", label: "Brazil (music.amazon.com.br)" },
  { id: "com.au", label: "Australia (music.amazon.com.au)" },
  { id: "co.jp", label: "Japan (music.amazon.co.jp)" },
  { id: "in", label: "India (music.amazon.in)" },
  { id: "com.tr", label: "Turkey (music.amazon.com.tr)" },
  { id: "pl", label: "Poland (music.amazon.pl)" },
  { id: "se", label: "Sweden (music.amazon.se)" },
  { id: "ae", label: "United Arab Emirates (music.amazon.ae)" },
  { id: "sa", label: "Saudi Arabia (music.amazon.sa)" },
];

export const REGION_IDS: ReadonlySet<string> = new Set(REGIONS.map((r) => r.id));

/**
 * ISO-3166 country code -> storefront suffix. Used when the region setting is
 * "auto"; anything unmapped falls back to `com`.
 *
 * The previous version derived this from the *language* subtag, which is why
 * every non-en/de/fr/it/es locale silently landed on the US storefront, and why
 * the "in" entry never matched anything ("in" is a country, not a language).
 */
const COUNTRY_TO_REGION: Readonly<Record<string, string>> = {
  US: "com",
  GB: "co.uk",
  IE: "co.uk",
  DE: "de",
  AT: "de",
  CH: "de",
  FR: "fr",
  BE: "fr",
  IT: "it",
  ES: "es",
  NL: "nl",
  CA: "ca",
  MX: "com.mx",
  BR: "com.br",
  AU: "com.au",
  NZ: "com.au",
  JP: "co.jp",
  IN: "in",
  TR: "com.tr",
  PL: "pl",
  SE: "se",
  AE: "ae",
  SA: "sa",
};

/** Language subtag -> storefront, for locales that carry no country code. */
const LANGUAGE_TO_REGION: Readonly<Record<string, string>> = {
  en: "com",
  de: "de",
  fr: "fr",
  it: "it",
  es: "es",
  nl: "nl",
  pt: "com.br",
  ja: "co.jp",
  hi: "in",
  tr: "com.tr",
  pl: "pl",
  sv: "se",
  ar: "ae",
};

/** Resolve a BCP-47 locale such as `en-GB` or `pt-BR` to a storefront suffix. */
export function regionFromLocale(locale: string): string {
  const parts = (locale || "").replace(/_/g, "-").split("-");
  const language = (parts[0] || "").toLowerCase();
  const country = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p));

  if (country) {
    const byCountry = COUNTRY_TO_REGION[country.toUpperCase()];
    if (byCountry) {
      return byCountry;
    }
  }
  return LANGUAGE_TO_REGION[language] ?? "com";
}

/**
 * Extract the storefront from a `music.amazon.*` hostname, or null if it is not
 * a storefront we know. Used to remember where Amazon actually redirected us.
 */
export function regionFromHost(hostname: string): string | null {
  const match = /^music\.amazon\.(.+)$/.exec(hostname.toLowerCase());
  if (!match) {
    return null;
  }
  return REGION_IDS.has(match[1]) ? match[1] : null;
}

export function musicUrlForRegion(region: string): string {
  const id = REGION_IDS.has(region) ? region : "com";
  return `https://music.amazon.${id}/`;
}

/**
 * Hosts we allow top-level navigation to. Everything else is handed to the
 * system browser instead of being opened inside the app.
 *
 * This only constrains *page navigation* — subresources (scripts, XHR, media
 * segments, license requests) are unaffected, so it cannot break playback.
 */
export function isAllowedNavigation(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  return isAmazonHost(parsed.hostname);
}

export function isAmazonHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    // amazon.com, music.amazon.co.uk, www.amazon.de, ...
    /(^|\.)amazon\.(com|co\.uk|de|fr|it|es|nl|ca|com\.mx|com\.br|com\.au|co\.jp|in|com\.tr|pl|se|ae|sa|cn|sg|eg)$/.test(host) ||
    // Sign-in, CAPTCHA and asset hosts used by the auth flow.
    /(^|\.)(media-amazon|ssl-images-amazon|amazonaws|images-amazon|aiv-cdn)\.(com|net)$/.test(host) ||
    /(^|\.)primevideo\.com$/.test(host)
  );
}

/** Artwork may only be fetched from Amazon's own image CDNs. */
export function isAllowedArtworkUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && isAmazonHost(parsed.hostname);
}
