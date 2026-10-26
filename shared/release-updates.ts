export interface ReleaseManifest {
  version: string; releasedAt: string; summary: string;
  securityNotes: string; migrationNotes: string; acceptanceNotes: string;
}
export interface ReleaseStatus {
  installedVersion: string; latest?: ReleaseManifest;
  checkedAt?: string; lastSuccessfulCheckAt?: string;
  state: 'current' | 'available' | 'ahead' | 'offline'; stale: boolean;
}
export const UPGRADE_GUIDE = 'https://github.com/sparkpressstudios/square-pickup-storefront/blob/main/docs/UPGRADES.md';
export const RELEASE_GUIDE = 'https://github.com/sparkpressstudios/square-pickup-storefront/blob/main/docs/RELEASE-POLICY.md';
export const CHANGELOG = 'https://github.com/sparkpressstudios/square-pickup-storefront/blob/main/CHANGELOG.md';
