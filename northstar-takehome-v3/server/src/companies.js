// Fixed, pre-generated tokens (not derived from company name/slug) so dashboard
// links stay stable across re-ingests and fresh clones. Not a secrets leak for a
// take-home: this is the equivalent of a checked-in seed/fixture value.
export const COMPANIES = {
  lumen: {
    slug: "lumen",
    name: "Lumen Co",
    timezone: "America/Los_Angeles",
    currency: "USD",
    dashboardToken: "551c26ff3a0ccd4f85eb6f247d4053475525c8d7244f9604",
  },
  harbor: {
    slug: "harbor",
    name: "Harbor Co",
    timezone: "Australia/Sydney",
    currency: "AUD",
    dashboardToken: "668f37f9758664de0943d2954ea73b123991b18ef441faf2",
  },
};

export const DEFAULT_RANGE = { start: "2026-08-01", end: "2026-08-14" };
