/** Non-secret merchant metadata only. This contract cannot authorize live payments. */
export type PickupWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface PickupHours {
  /** Local calendar weekday: Sunday=0 through Saturday=6. Split overnight hours at midnight. */
  readonly weekday: PickupWeekday;
  readonly opens: string;
  readonly closes: string;
}
export interface MerchantPickupPolicy {
  readonly timeZone: string;
  /** Elapsed minutes before pickup, including across daylight-saving transitions. */
  readonly leadMinutes: number;
  readonly weeklyHours: readonly PickupHours[];
  /** Local dates, not UTC dates. */
  readonly blackoutDates: readonly string[];
}
export interface MerchantReadinessConfiguration {
  readonly reviewed: boolean;
  readonly branding: {
    readonly name: string;
    readonly tagline: string;
    readonly accentColor: string;
    readonly backgroundColor: string;
    readonly logoUrl?: string;
  };
  readonly support: { readonly email: string; readonly url: string };
  readonly policies: { readonly termsUrl: string; readonly privacyUrl: string; readonly refundUrl: string };
  readonly inventory: {
    readonly authority: 'website-allocation' | 'square-pos';
    readonly allocationReviewed: boolean;
  };
  readonly pickup: MerchantPickupPolicy;
}
export interface ReadinessIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export interface MerchantReadinessReport {
  /** Configuration gate only; never a payment/environment or launch authorization. */
  readonly ready: boolean;
  readonly issues: readonly ReadinessIssue[];
  /** Only returned when every field is structurally valid; never echoes arbitrary input. */
  readonly configuration?: MerchantReadinessConfiguration;
}
export interface PickupAvailability {
  readonly available: boolean;
  readonly promisedAt?: string;
  readonly timeZone?: string;
  readonly reason?: 'INVALID_POLICY' | 'INVALID_TIME' | 'LEAD_TIME_REQUIRED' | 'OUTSIDE_BOOKING_WINDOW' | 'BLACKOUT_DATE' | 'OUTSIDE_PICKUP_HOURS' | 'NO_AVAILABILITY';
}
