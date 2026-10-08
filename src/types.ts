export interface Env {
  BETTER_INTRA_KV: KVNamespace;
  better_intra_d1: D1Database;
  better_intra_images: R2Bucket;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  CALLBACK_URL?: string;
  TOKEN_ENCRYPTION_KEY?: string; // base64-encoded 256-bit key for AES-GCM
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_ENABLED?: string;
  PROJECT_REFRESH_SECRET?: string;
  DISCORD_GUILD_ID?: string;
  PROXY_SECRET?: string;
  ANNOUNCEMENT_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  ALLOW_LOCAL_DEV?: string;
  INTRA_RELAY_URL?: string;
  INTRA_RELAY_KEY?: string;
}

export interface SessionMeta {
  id: string;
  label: string;
  name?: string;
  country?: string;
  createdAt: number;
}

export type UserData = {
  sessionTokens?: string[];
  sessionToken?: string;
  sessionMeta?: Record<string, SessionMeta>;
  settings?: Record<string, unknown>;
  settingsRevision?: string;
  settingsHistory?: {
    revision: string | null;
    createdAt: number;
    settings: Record<string, unknown>;
  }[];
  fortyTwoToken?: string; // AES-GCM encrypted JSON: { access_token, refresh_token, expires_at }
  fortyTwoUserId?: number;
  discordId?: string;
  discordUsername?: string;
  discordQuietEnabled?: boolean;
  discordQuietStart?: string;
  discordQuietEnd?: string;
  discordQuietTimezone?: number;
  tokenBroken?: boolean;
  tokenFailures?: number;
  discordTestedAt?: number;
  pushSubscriptions?: PushSubscription[];
};

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  ua?: string;
  addedAt: number;
}

export interface MeData {
  login: string;
  displayName: string;
  image: string | null;
  wallet: number;
  correctionPoints: number;
  level: number;
  grade: string | null;
  campusId: number | null;
  campusName: string | null;
  poolLabel: string | null;
  customAvatar: string | null;
  avatarBg: string;
  avatarPosX: number;
  avatarPosY: number;
  avatarScale: number;
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface UserResponse {
  id?: number;
  login?: string;
  campus?: Array<{ id: number; name: string }>;
  pool_month?: string;
  pool_year?: string;
}

export interface ProjectResponse {
  id: number;
  name: string;
  slug: string;
}

export interface ScaleTeamItem {
  id: number;
  begin_at: string;
  scale?: { duration?: number };
  team?: { project_id?: number; name?: string };
  correcteds?: unknown;
  corrector?: unknown;
}

export interface FortyTwoUser {
  id: number;
  login: string;
}

export interface CursusUser {
  id: number;
  user: {
    id: number;
    login: string;
    location?: string | null;
    pool_month?: string;
    pool_year?: string;
    displayname?: string;
    image?: { link?: string; versions?: { small?: string } };
    wallet?: number;
    correction_point?: number;
  };
  level: number;
  grade?: string;
  cursus_id: number;
}
